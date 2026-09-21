// Manifestとアイコンの検証ログ
(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) {
    addDiag('エラー: manifest linkタグがありません');
    return;
  }
  try {
    const res = await fetch(link.href);
    if (!res.ok) {
      addDiag(`Manifest取得失敗: HTTP ${res.status}`);
      return;
    }
    const json = await res.json();
    addDiag(`Manifest読込OK: ${json.short_name || json.name}`);
    
    // アイコンの取得チェック
    if (json.icons && json.icons.length > 0) {
      const iconUrl = json.icons[0].src;
      const imgRes = await fetch(iconUrl);
      addDiag(`アイコン取得: HTTP ${imgRes.status}`);
    } else {
      addDiag('エラー: iconsが未定義です');
    }
  } catch (e) {
    addDiag(`Manifestエラー: ${e.message}`);
  }
})();

// 状態表示ログ
function addDiag(msg) {
  const el = document.getElementById('diagBar');
  if (el) {
    const time = new Date().toLocaleTimeString();
    el.innerHTML += `<div>[${time}] ${msg}</div>`;
  }
}

// Service Worker 登録（絶対パス）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/pocket-printer/sw.js', { scope: '/pocket-printer/' })
      .then((reg) => addDiag(`SW登録OK: ${reg.scope}`))
      .catch((err) => addDiag(`SWエラー: ${err.message}`));
  });
}

// C50 サーマルプリンター規格定数 (LPC50_95A5 ESC/POS)
const WIDTH_PX = 384;
const WIDTH_BYTES = 48; // 384 / 8
const CHUNK_SIZE = 128; // BLE パケットサイズ
const CHUNK_DELAY = 12; // パケット間ウェイト (ms)
const FEED_DOTS = 16;   // 2.0mm余白 (8 dot/mm * 2.0mm)

// DOM要素
const statusEl = document.getElementById('status');
const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const btnConnect = document.getElementById('btnConnect');
const btnPrint = document.getElementById('btnPrint');
const btnInstall = document.getElementById('btnInstall');
const modeSelect = document.getElementById('modeSelect');
const offsetControl = document.getElementById('offsetControl');
const offsetRange = document.getElementById('offsetRange');
const offsetVal = document.getElementById('offsetVal');
const urlInput = document.getElementById('urlInput');
const btnLoadUrl = document.getElementById('btnLoadUrl');
const selectZone = document.getElementById('selectZone');
const fileInput = document.getElementById('fileInput');

let bleDevice = null;
let writeChar = null;
let isPrinting = false;
let sourceImage = null;
let cachedRaster = null;
let loadCounter = 0;
let currentBlobUrl = null;
let deferredPrompt = null;

const setStatus = (msg) => { statusEl.textContent = msg; };

const updateUI = () => {
  const isConnected = Boolean(bleDevice?.gatt?.connected && writeChar);
  btnPrint.disabled = !(isConnected && cachedRaster && !isPrinting);
  btnConnect.disabled = isPrinting;
  btnLoadUrl.disabled = isPrinting;
  modeSelect.disabled = isPrinting;
  offsetRange.disabled = isPrinting;
};

// =============================================================================
// PWA インストールプロンプト制御
// =============================================================================
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  addDiag('インストール資格OK！ボタンを表示しました');
  if (btnInstall) {
    btnInstall.style.display = 'inline-block';
  }
});

if (btnInstall) {
  btnInstall.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    addDiag(`インストール結果: ${outcome}`);
    deferredPrompt = null;
    btnInstall.style.display = 'none';
  });
}

window.addEventListener('appinstalled', () => {
  if (btnInstall) btnInstall.style.display = 'none';
  addDiag('アプリをインストールしました');
});

// =============================================================================
// Web Share Target（共有受け取り）
// =============================================================================
async function checkSharedImage() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('from_share') === '1') {
    try {
      const cache = await caches.open('shared-image');
      const res = await cache.match('incoming-image');
      if (res) {
        const blob = await res.blob();
        loadImageSource(URL.createObjectURL(blob), true);
        await cache.delete('incoming-image');
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch (err) {
      addDiag(`共有画像読込エラー: ${err.message}`);
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkSharedImage);
} else {
  checkSharedImage();
}

// =============================================================================
// 画像URL入力・取得
// =============================================================================
function extractTargetUrl(input) {
  const text = input ? input.trim() : '';
  if (!text) return null;
  if (text.startsWith('data:image/')) return text;

  try {
    const parsed = new URL(text);
    if (parsed.searchParams.has('imgurl')) {
      const decoded = decodeURIComponent(parsed.searchParams.get('imgurl'));
      return decoded.startsWith('http://') || decoded.startsWith('https://') ? decoded : null;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return text;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function handleUrlLoad() {
  const target = extractTargetUrl(urlInput.value);
  if (!target) {
    setStatus('有効な画像URLを入力してください');
    return;
  }
  loadImageSource(target, false);
}

btnLoadUrl.onclick = handleUrlLoad;
urlInput.onkeydown = (e) => {
  if (e.key === 'Enter') handleUrlLoad();
};

// =============================================================================
// 画像変換 (リサイズ + 大津2値化 + FS誤差拡散 + ESC/POSパッキング)
// =============================================================================
function renderAndProcess() {
  if (!sourceImage) return;

  const mode = modeSelect.value;
  const hFixed = 230;
  const h = (mode === 'free')
    ? Math.max(1, Math.round(sourceImage.height * (WIDTH_PX / sourceImage.width)))
    : hFixed;

  canvas.width = WIDTH_PX;
  canvas.height = h;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, WIDTH_PX, h);

  if (mode === 'free') {
    ctx.drawImage(sourceImage, 0, 0, WIDTH_PX, h);
  } else if (mode === 'fixed-fit') {
    const scale = Math.min(WIDTH_PX / sourceImage.width, h / sourceImage.height);
    const dw = Math.round(sourceImage.width * scale);
    const dh = Math.round(sourceImage.height * scale);
    ctx.drawImage(sourceImage, Math.round((WIDTH_PX - dw) / 2), Math.round((h - dh) / 2), dw, dh);
  } else {
    const scale = WIDTH_PX / sourceImage.width;
    const dh = Math.round(sourceImage.height * scale);
    const overflow = dh - h;
    const offset = parseInt(offsetRange.value, 10) / 100;
    const dy = overflow > 0 ? -Math.round(overflow * offset) : Math.round((h - dh) / 2);
    ctx.drawImage(sourceImage, 0, dy, WIDTH_PX, dh);
  }

  const imgData = ctx.getImageData(0, 0, WIDTH_PX, h);
  const d = imgData.data;
  const total = WIDTH_PX * h;

  const gray = new Float32Array(total);
  const hist = new Int32Array(256);
  let sum = 0;

  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const val = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    gray[j] = val;
    hist[val]++;
    sum += val;
  }

  let sumB = 0, wB = 0, varMax = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const diff = (sumB * total) - (sum * wB);
    const between = (diff * diff) / (wB * wF);
    if (between > varMax) {
      varMax = between;
      threshold = t;
    }
  }
  threshold = Math.max(70, Math.min(185, threshold));

  // ESC/POS GS v 0 ヘッダー
  const raster = new Uint8Array(8 + (WIDTH_BYTES * h));
  raster.set([
    0x1D, 0x76, 0x30, 0x00,
    WIDTH_BYTES & 0xFF, (WIDTH_BYTES >> 8) & 0xFF,
    h & 0xFF, (h >> 8) & 0xFF
  ], 0);

  let rasterIdx = 8;
  for (let y = 0; y < h; y++) {
    const row = y * WIDTH_PX;
    for (let x = 0; x < WIDTH_BYTES; x++) {
      let byte = 0;
      const colBase = x * 8;
      for (let b = 0; b < 8; b++) {
        const px = colBase + b;
        const idx = row + px;
        const oldVal = gray[idx];
        const isBlack = oldVal < threshold;
        const newVal = isBlack ? 0 : 255;
        const err = oldVal - newVal;

        if (px + 1 < WIDTH_PX) gray[idx + 1] += err * 0.4375;
        if (y + 1 < h) {
          const next = idx + WIDTH_PX;
          if (px > 0) gray[next - 1] += err * 0.1875;
          gray[next] += err * 0.3125;
          if (px + 1 < WIDTH_PX) gray[next + 1] += err * 0.0625;
        }

        if (isBlack) byte |= (0x80 >> b);

        const pIdx = idx * 4;
        d[pIdx] = d[pIdx + 1] = d[pIdx + 2] = newVal;
        d[pIdx + 3] = 255; // 透過PNGの描画バグ防止
      }
      raster[rasterIdx++] = byte;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  cachedRaster = raster;
  updateUI();
}

function loadImageSource(src, isBlob = false) {
  if (isPrinting || !src) return Promise.reject(new Error('Invalid state'));
  const currentToken = ++loadCounter;
  setStatus('画像を読み込んでいます...');

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';

    img.onload = () => {
      if (currentToken !== loadCounter) {
        if (isBlob) URL.revokeObjectURL(src);
        resolve();
      } else {
        if (currentBlobUrl && currentBlobUrl !== src) {
          URL.revokeObjectURL(currentBlobUrl);
        }
        currentBlobUrl = isBlob ? src : null;
        sourceImage = img;
        renderAndProcess();
        setStatus('印刷準備完了');
        resolve();
      }
    };

    img.onerror = () => {
      if (currentToken !== loadCounter) {
        if (isBlob) URL.revokeObjectURL(src);
        resolve();
        return;
      }

      if (!isBlob && !src.startsWith('data:') && !src.startsWith('https://corsproxy.io/?')) {
        loadImageSource('https://corsproxy.io/?' + encodeURIComponent(src), false)
          .then(resolve)
          .catch(reject);
      } else {
        if (isBlob) URL.revokeObjectURL(src);
        setStatus('画像の取得に失敗しました。端末内のファイル選択をお使いください。');
        updateUI();
        reject(new Error('Load failed'));
      }
    };

    img.src = src;
  });
}

// =============================================================================
// Bluetooth 通信制御 (LPC50_95A5 BLE 0xff00/0xff02)
// =============================================================================
const onDisconnected = () => {
  writeChar = null;
  isPrinting = false;
  setStatus('プリンターが切断されました');
  updateUI();
};

btnConnect.onclick = async () => {
  try {
    setStatus('プリンターを探しています...');
    if (bleDevice) {
      bleDevice.removeEventListener('gattserverdisconnected', onDisconnected);
    }

    bleDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [0xff00]
    });

    bleDevice.addEventListener('gattserverdisconnected', onDisconnected);

    const server = await bleDevice.gatt.connect();
    const service = await server.getPrimaryService(0xff00);
    writeChar = await service.getCharacteristic(0xff02);

    setStatus('プリンターに接続しました');
    updateUI();
  } catch (err) {
    setStatus('接続キャンセル: ' + (err.message || err));
    updateUI();
  }
};

btnPrint.onclick = async () => {
  if (!writeChar || !cachedRaster || isPrinting) return;
  isPrinting = true;
  updateUI();

  try {
    setStatus('印刷データを送信中...');
    await sendPacket(new Uint8Array([0x10, 0xFF, 0xF1, 0x03, 0x10, 0xFF, 0x10, 0x00, 0x02]));
    await sendPacket(cachedRaster);
    await sendPacket(new Uint8Array([0x1B, 0x4A, FEED_DOTS, 0x10, 0xFF, 0xF1, 0x45]));
    await new Promise(r => setTimeout(r, 80));
    setStatus('印刷が完了しました');
  } catch (err) {
    setStatus('印刷エラー: ' + (err.message || err));
  } finally {
    isPrinting = false;
    updateUI();
  }
};

async function sendPacket(bytes) {
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    if (!bleDevice?.gatt?.connected) throw new Error('通信が切断されました');
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    if (writeChar.writeValueWithResponse) {
      await writeChar.writeValueWithResponse(chunk);
    } else {
      await writeChar.writeValue(chunk);
    }
    await new Promise(r => setTimeout(r, CHUNK_DELAY));
  }
}

modeSelect.onchange = () => {
  offsetControl.style.display = (modeSelect.value === 'fixed-crop') ? 'block' : 'none';
  renderAndProcess();
};

offsetRange.oninput = () => {
  const v = parseInt(offsetRange.value, 10);
  offsetVal.textContent = (v === 0) ? '上寄り' : (v === 50) ? '中央' : (v === 100) ? '下寄り' : (v + '%');
  renderAndProcess();
};

selectZone.onclick = () => {
  if (!isPrinting) fileInput.click();
};

fileInput.onchange = (e) => {
  const file = e.target.files?.[0];
  if (file) {
    loadImageSource(URL.createObjectURL(file), true);
    fileInput.value = '';
  }
};
