// C50 サーマルプリンター規格定数 (LPC50_95A5 ESC/POS)
const WIDTH_PX = 384;
const WIDTH_BYTES = 48; // 1行あたりのバイト数
const FEED_DOTS = 16;

const statusEl = document.getElementById('status');
const canvas = document.getElementById('previewCanvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const btnConnect = document.getElementById('btnConnect');
const btnPrint = document.getElementById('btnPrint');
const pasteZone = document.getElementById('pasteZone');
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
let currentTotalLines = 0;
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
// ペースト処理（画像バイナリ / Discord等の画像リンク両対応）
// =============================================================================
pasteZone.addEventListener('paste', async (e) => {
  e.preventDefault();
  const clipboard = e.clipboardData;
  if (!clipboard) return;

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

  const rawText = clipboard.getData('text');
  if (rawText) {
    const targetUrl = extractTargetUrl(rawText);
    if (targetUrl) {
      pasteZone.textContent = targetUrl;
      loadImageSource(targetUrl, false);
    } else {
      pasteZone.textContent = rawText.trim();
      setStatus('画像または有効な画像リンクを認識できませんでした');
    }
  }
});

function extractTargetUrl(input) {
  if (!input) return null;
  const text = input.trim();
  if (text.startsWith('data:image/')) return text;

  const match = text.match(/https?:\/\/[^\s"'>]+/);
  if (!match) return null;
  const rawUrl = match[0];

  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.has('imgurl')) {
      const decoded = decodeURIComponent(parsed.searchParams.get('imgurl'));
      if (decoded.startsWith('http')) return decoded;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return rawUrl;
    }
    return null;
  } catch (_) {
    return null;
  }
}

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

async function fetchImageBlob(src) {
  if (src.startsWith('blob:') || src.startsWith('data:')) {
    const res = await fetch(src);
    return await res.blob();
  }

  try {
    const directRes = await fetchWithTimeout(src, { mode: 'cors' }, 3000);
    if (directRes.ok) return await directRes.blob();
  } catch (_) {}

  try {
    const p1 = `https://corsproxy.io/?${encodeURIComponent(src)}`;
    const r1 = await fetchWithTimeout(p1, {}, 4000);
    if (r1.ok) return await r1.blob();
  } catch (_) {}

  try {
    const p2 = `https://api.allorigins.win/raw?url=${encodeURIComponent(src)}`;
    const r2 = await fetchWithTimeout(p2, {}, 4000);
    if (r2.ok) return await r2.blob();
  } catch (_) {}

  throw new Error('すべての画像取得経路が失敗しました');
}

// =============================================================================
// 画像変換 (リサイズ + 左右反転 + 大津2値化 + FS誤差拡散 + ESC/POSラスタ生成)
// =============================================================================
function renderAndProcess() {
  if (!sourceImage) return;

  const mode = modeSelect.value;
  let targetH = 120;
  const boxW_5x6 = WIDTH_PX; // 384px
  const boxH_5x6 = 461;      // 461px

  if (mode === 'free') {
    targetH = Math.max(1, Math.round(sourceImage.height * (WIDTH_PX / sourceImage.width)));
  } else if (mode === 'fixed-fit' || mode === 'fixed-crop') {
    targetH = 230; // 5×3 cm
  } else if (mode === 'fixed-5x6-fit' || mode === 'fixed-5x6-crop') {
    targetH = boxH_5x6; // 5×6 cm
  }

  currentTotalLines = targetH;
  canvas.width = WIDTH_PX;
  canvas.height = targetH;

  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, WIDTH_PX, targetH);

  if (mode === 'free') {
    ctx.drawImage(sourceImage, 0, 0, WIDTH_PX, targetH);
  } else if (mode === 'fixed-fit') {
    const scale = Math.min(WIDTH_PX / sourceImage.width, targetH / sourceImage.height);
    const dw = Math.round(sourceImage.width * scale);
    const dh = Math.round(sourceImage.height * scale);
    ctx.drawImage(sourceImage, Math.round((WIDTH_PX - dw) / 2), Math.round((targetH - dh) / 2), dw, dh);
  } else if (mode === 'fixed-crop') {
    const scale = WIDTH_PX / sourceImage.width;
    const dh = Math.round(sourceImage.height * scale);
    const overflow = dh - targetH;
    const offset = parseInt(offsetRange.value, 10) / 100;
    const dy = overflow > 0 ? -Math.round(overflow * offset) : Math.round((targetH - dh) / 2);
    ctx.drawImage(sourceImage, 0, dy, WIDTH_PX, dh);
  } else if (mode === 'fixed-5x6-fit') {
    const scale = Math.min(boxW_5x6 / sourceImage.width, boxH_5x6 / sourceImage.height);
    const dw = Math.round(sourceImage.width * scale);
    const dh = Math.round(sourceImage.height * scale);
    const dx = Math.round((WIDTH_PX - dw) / 2);
    const dy = Math.round((targetH - dh) / 2);

    ctx.translate(WIDTH_PX, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(sourceImage, dx, dy, dw, dh);
  } else if (mode === 'fixed-5x6-crop') {
    const scale = WIDTH_PX / sourceImage.width;
    const dh = Math.round(sourceImage.height * scale);
    const overflow = dh - boxH_5x6;
    const offset = parseInt(offsetRange.value, 10) / 100;
    const dy = overflow > 0 ? -Math.round(overflow * offset) : Math.round((boxH_5x6 - dh) / 2);

    ctx.translate(WIDTH_PX, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(sourceImage, 0, dy, WIDTH_PX, dh);
  }
  ctx.restore();

  const imgData = ctx.getImageData(0, 0, WIDTH_PX, targetH);
  const d = imgData.data;
  const total = WIDTH_PX * targetH;

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

  const raster = new Uint8Array(8 + (WIDTH_BYTES * targetH));
  raster.set([
    0x1D, 0x76, 0x30, 0x00,
    WIDTH_BYTES & 0xFF, (WIDTH_BYTES >> 8) & 0xFF,
    targetH & 0xFF, (targetH >> 8) & 0xFF
  ], 0);

  let rasterIdx = 8;
  for (let y = 0; y < targetH; y++) {
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
        if (y + 1 < targetH) {
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

function loadImageSource(src, isBlob = false) {
  if (isPrinting || !src) return;
  const currentToken = ++loadCounter;
  setStatus('画像を処理しています...');

  (async () => {
    try {
      let finalUrl = src;
      let createdBlob = false;

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
          reject(new Error('Image render failed'));
        };
        img.src = finalUrl;
      });
    } catch (err) {
      if (currentToken === loadCounter) {
        setStatus('画像の取得に失敗しました。リンクの有効期限やファイル選択をご確認ください。');
        updateUI();
      }
    }
  })();
}

// =============================================================================
// Bluetooth 通信制御 (LPC50_95A5 BLE 0xff00/0xff02)
// 「行単位(48バイト)アライメント送信」でパケット欠落・隙間を徹底防止
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
    setStatus('印刷中... (同期送信)');
    // 1. 初期化コマンド
    await sendRawChunk(new Uint8Array([0x10, 0xFF, 0xF1, 0x03, 0x10, 0xFF, 0x10, 0x00, 0x02]));
    await new Promise(r => setTimeout(r, 40));

    // 2. GS v 0 ヘッダー（8バイト）
    const header = cachedRaster.subarray(0, 8);
    await sendRawChunk(header);
    await new Promise(r => setTimeout(r, 20));

    // 3. 画像ビットマップデータを行単位（1行 = 48バイト）で厳密に送信
    // 行の途中でパケットが分断されないため、データのドロップや横筋の隙間が物理的に発生しない
    const data = cachedRaster.subarray(8);
    const totalBytes = data.length;

    for (let offset = 0; offset < totalBytes; offset += WIDTH_BYTES) {
      if (!bleDevice?.gatt?.connected) throw new Error('通信が切断されました');

      const lineChunk = data.subarray(offset, offset + WIDTH_BYTES);
      await sendRawChunk(lineChunk);

      // C50のサーマルヘッド加熱スピードに完全に同調（約12ms/行）
      await new Promise(r => setTimeout(r, 12));
    }

    // 4. 給紙・印字終了
    await new Promise(r => setTimeout(r, 60));
    await sendRawChunk(new Uint8Array([0x1B, 0x4A, FEED_DOTS, 0x10, 0xFF, 0xF1, 0x45]));
    await new Promise(r => setTimeout(r, 100));

    setStatus('印刷が完了しました');
  } catch (err) {
    setStatus('印刷エラー: ' + (err.message || err));
  } finally {
    isPrinting = false;
    updateUI();
  }
};

async function sendRawChunk(chunk) {
  if (writeChar.writeValueWithResponse) {
    await writeChar.writeValueWithResponse(chunk);
  } else {
    await writeChar.writeValue(chunk);
  }
}

modeSelect.onchange = () => {
  const isCrop = (modeSelect.value === 'fixed-crop' || modeSelect.value === 'fixed-5x6-crop');
  offsetControl.style.display = isCrop ? 'block' : 'none';
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
