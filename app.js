const WIDTH_PX = 384;
const WIDTH_BYTES = 48;
const CHUNK_SIZE = 128;
const CHUNK_DELAY = 12;
const FEED_DOTS = 16;

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
  if (btnInstall) btnInstall.style.display = 'inline-block';
});

if (btnInstall) {
  btnInstall.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    btnInstall.style.display = 'none';
  });
}

window.addEventListener('appinstalled', () => {
  if (btnInstall) btnInstall.style.display = 'none';
});

// =============================================================================
// Web Share Target（共有受け取り：POST一時キャッシュ）
// =============================================================================
async function checkSharedData() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('from_share') === '1') {
    try {
      const cache = await caches.open('shared-image');
      
      const fileRes = await cache.match('incoming-image');
      if (fileRes) {
        const blob = await fileRes.blob();
        loadImageSource(URL.createObjectURL(blob), true);
        await cache.delete('incoming-image');
      } else {
        const urlRes = await cache.match('incoming-url');
        if (urlRes) {
          const rawShared = await urlRes.text();
          await cache.delete('incoming-url');
          processIncomingShareText(rawShared);
        }
      }
      window.history.replaceState({}, '', window.location.pathname);
    } catch (err) {
      console.warn('共有受取エラー:', err);
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkSharedData);
} else {
  checkSharedData();
}

// タイムアウト付きフェッチ（待たされ防止：最大4秒）
async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Google短縮URL、WebページURLの解読
async function processIncomingShareText(text) {
  const rawUrl = extractTargetUrl(text);
  if (!rawUrl) {
    setStatus('共有データからURLを検出できませんでした');
    return;
  }

  urlInput.value = rawUrl;

  // 1. URL自体の中に画像URLや転送先がパラメータとして埋まっているか即時チェック（最速・通信不要）
  try {
    const parsed = new URL(rawUrl);
    for (const key of ['imgurl', 'image_url', 'media_url', 'url', 'src', 'target']) {
      const val = parsed.searchParams.get(key);
      if (val && (val.startsWith('http://') || val.startsWith('https://'))) {
        const decoded = decodeURIComponent(val);
        urlInput.value = decoded;
        loadImageSource(decoded, false);
        return;
      }
    }
  } catch (_) {}

  // 2. Google共有リンクや短縮リンクの場合のHTML解析（タイムアウト付きで高速化）
  if (rawUrl.includes('share.google') || rawUrl.includes('google.com') || rawUrl.includes('g.co')) {
    setStatus('Googleリンクを解析中...');
    
    const proxies = [
      (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`
    ];

    for (const proxyFn of proxies) {
      try {
        const res = await fetchWithTimeout(proxyFn(rawUrl), {}, 4000);
        if (!res.ok) continue;
        const html = await res.text();

        // (A) OGPメタタグ
        const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
                        html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
        if (ogMatch && ogMatch[1]) {
          let extracted = ogMatch[1].replace(/&amp;/g, '&');
          if (extracted.startsWith('//')) extracted = 'https:' + extracted;
          urlInput.value = extracted;
          loadImageSource(extracted, false);
          return;
        }

        // (B) HTML内のimgurlパラメータ
        const imgMatch = html.match(/imgurl=([^&"'>]+)/);
        if (imgMatch && imgMatch[1]) {
          const decoded = decodeURIComponent(imgMatch[1]);
          urlInput.value = decoded;
          loadImageSource(decoded, false);
          return;
        }

        // (C) Google画像キャッシュ (encrypted-tbn0)
        const tbnMatch = html.match(/https:\/\/encrypted-tbn[0-9]\.gstatic\.com\/images\?q=[^"'>\s]+/);
        if (tbnMatch) {
          urlInput.value = tbnMatch[0];
          loadImageSource(tbnMatch[0], false);
          return;
        }
      } catch (err) {
        console.warn('Proxy retry next:', err);
      }
    }
  }

  // フォールバック：通常の画像読み込み
  loadImageSource(rawUrl, false);
}

function extractTargetUrl(input) {
  const text = input ? input.trim() : '';
  if (!text) return null;
  if (text.startsWith('data:image/')) return text;

  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : (text.startsWith('http') ? text : null);
}

function handleUrlLoad() {
  processIncomingShareText(urlInput.value);
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
        d[pIdx + 3] = 255;
      }
      raster[rasterIdx++] = byte;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  cachedRaster = raster;
  updateUI();
}

async function loadImageBlob(src) {
  if (src.startsWith('blob:') || src.startsWith('data:')) {
    const res = await fetch(src);
    return await res.blob();
  }

  try {
    const directRes = await fetchWithTimeout(src, { mode: 'cors' }, 3000);
    if (directRes.ok) return await directRes.blob();
  } catch (_) {}

  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(src)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(src)}`
  ];

  for (const p of proxies) {
    try {
      const res = await fetchWithTimeout(p, {}, 3500);
      if (res.ok) return await res.blob();
    } catch (_) {}
  }
  throw new Error('All image fetch sources failed');
}

function loadImageSource(src, isBlob = false) {
  if (isPrinting || !src) return Promise.reject(new Error('Invalid state'));
  const currentToken = ++loadCounter;
  setStatus('画像を読み込んでいます...');

  return (async () => {
    try {
      let finalUrl = src;
      let createdBlob = false;

      if (!isBlob && !src.startsWith('data:')) {
        const blob = await loadImageBlob(src);
        if (currentToken !== loadCounter) return;
        finalUrl = URL.createObjectURL(blob);
        createdBlob = true;
      }

      await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          if (currentToken !== loadCounter) {
            if (createdBlob) URL.revokeObjectURL(finalUrl);
            resolve();
            return;
          }
          if (currentBlobUrl && currentBlobUrl !== finalUrl) {
            URL.revokeObjectURL(currentBlobUrl);
          }
          currentBlobUrl = (isBlob || createdBlob) ? finalUrl : null;
          sourceImage = img;
          renderAndProcess();
          setStatus('印刷準備完了');
          resolve();
        };
        img.onerror = () => {
          if (createdBlob) URL.revokeObjectURL(finalUrl);
          reject(new Error('Image render error'));
        };
        img.src = finalUrl;
      });
    } catch (err) {
      if (currentToken === loadCounter) {
        setStatus('Googleページの保護等で画像を取得できませんでした。Google画像検索で画像を長押し ➜「画像を共有」をお試しください。');
        updateUI();
      }
    }
  })();
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
