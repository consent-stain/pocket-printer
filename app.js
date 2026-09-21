// C50 サーマルプリンター規格定数 (LPC50_95A5 ESC/POS)
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
const pasteZone = document.getElementById('pasteZone');
const pasteHint = document.getElementById('pasteHint');
const modeSelect = document.getElementById('modeSelect');
const offsetControl = document.getElementById('offsetControl');
const offsetRange = document.getElementById('offsetRange');
const offsetVal = document.getElementById('offsetVal');
const selectZone = document.getElementById('selectZone');
const fileInput = document.getElementById('fileInput');

let bleDevice = null;
let writeChar = null;
let isPrinting = false;
let sourceImage = null;
let cachedRaster = null;
let loadCounter = 0;
let currentBlobUrl = null;

const setStatus = (msg) => { statusEl.textContent = msg; };

const updateUI = () => {
  const isConnected = Boolean(bleDevice?.gatt?.connected && writeChar);
  btnPrint.disabled = !(isConnected && cachedRaster && !isPrinting);
  btnConnect.disabled = isPrinting;
  modeSelect.disabled = isPrinting;
  offsetRange.disabled = isPrinting;
};

// =============================================================================
// ペースト処理（画像バイナリ / 画像アドレス両対応 & 多重フォールバック）
// =============================================================================
pasteZone.addEventListener('paste', async (e) => {
  e.preventDefault();
  const clipboard = e.clipboardData;
  if (!clipboard) return;

  // 1. 画像バイナリ（「画像をコピー」）
  const items = clipboard.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          pasteZone.textContent = '【画像を貼り付けました】';
          loadImageSource(URL.createObjectURL(file), true);
          return;
        }
      }
    }
  }

  // 2. HTML形式貼り付け内の <img> タグ検索
  const htmlData = clipboard.getData('text/html');
  if (htmlData) {
    const imgMatch = htmlData.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch && imgMatch[1]) {
      const src = imgMatch[1].replace(/&amp;/g, '&');
      pasteZone.textContent = src;
      loadImageSource(src, false);
      return;
    }
  }

  // 3. テキスト・URL（「画像アドレスをコピー」など）
  const rawText = clipboard.getData('text');
  if (rawText) {
    pasteZone.textContent = rawText.trim();
    const cleanUrl = extractTargetUrl(rawText);
    if (cleanUrl) {
      loadImageSource(cleanUrl, false);
    } else {
      setStatus('貼り付けられたテキストから画像アドレスを認識できませんでした');
    }
  }
});

// URL抽出ロジック（Google画像検索パラメータ、改行混入、Base64等に完全対応）
function extractTargetUrl(input) {
  if (!input) return null;
  const text = input.trim();
  if (text.startsWith('data:image/')) return text;

  // テキスト内から URL (http/https) を検出
  const match = text.match(/https?:\/\/[^\s"'>]+/);
  const rawUrl = match ? match[0] : text;

  try {
    const parsed = new URL(rawUrl);
    // Google画像検索等の imgurl パラメータを優先
    if (parsed.searchParams.has('imgurl')) {
      const decoded = decodeURIComponent(parsed.searchParams.get('imgurl'));
      if (decoded.startsWith('http')) return decoded;
    }
    // 一般的な画像拡張子、または画像配信URL
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return rawUrl;
    }
    return null;
  } catch (_) {
    return null;
  }
}

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

// タイムアウト付きフェッチ（フリーズ防止）
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

// 多段プロキシによる画像バイナリ（Blob）取得
async function fetchImageBlob(src) {
  if (src.startsWith('blob:') || src.startsWith('data:')) {
    const res = await fetch(src);
    return await res.blob();
  }

  // 1. 直接取得（CORS許可されているサーバー）
  try {
    const directRes = await fetchWithTimeout(src, { mode: 'cors' }, 2500);
    if (directRes.ok) return await directRes.blob();
  } catch (_) {}

  // 2. プロキシ1 (corsproxy.io)
  try {
    const p1 = `https://corsproxy.io/?${encodeURIComponent(src)}`;
    const r1 = await fetchWithTimeout(p1, {}, 3500);
    if (r1.ok) return await r1.blob();
  } catch (_) {}

  // 3. プロキシ2 (allorigins)
  try {
    const p2 = `https://api.allorigins.win/raw?url=${encodeURIComponent(src)}`;
    const r2 = await fetchWithTimeout(p2, {}, 3500);
    if (r2.ok) return await r2.blob();
  } catch (_) {}

  throw new Error('すべての画像取得経路が失敗しました');
}

function loadImageSource(src, isBlob = false) {
  if (isPrinting || !src) return Promise.reject(new Error('Invalid state'));
  const currentToken = ++loadCounter;
  setStatus('画像を読み込んでいます...');

  return (async () => {
    try {
      let finalUrl = src;
      let createdBlob = false;

      // 外部URLの場合はBlob化してCanvas汚染・CORSエラーを防止
      if (!isBlob && !src.startsWith('data:')) {
        const blob = await fetchImageBlob(src);
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
        setStatus('画像の取得に失敗しました。URLのアクセス権限またはファイル選択をお使いください。');
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
