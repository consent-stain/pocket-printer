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
// 画像バイナリのペースト処理（Webサイトからの「画像をコピー」専用）
// =============================================================================
pasteZone.addEventListener('paste', (e) => {
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
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlData, 'text/html');
    const imgEl = doc.querySelector('img');
    if (imgEl && imgEl.src && imgEl.src.startsWith('data:image/')) {
      pasteZone.textContent = '【画像を貼り付けました】';
      loadImageSource(imgEl.src, false);
      return;
    }
  }

  setStatus('クリップボードに画像が見つかりませんでした。「画像をコピー」してから貼り付けてください。');
});

// =============================================================================
// 画像変換 (リサイズ + 左右反転 + 大津2値化 + FS誤差拡散 + ESC/POSパッキング)
// =============================================================================
function renderAndProcess() {
  if (!sourceImage) return;

  const mode = modeSelect.value;
  let targetH = 120;
  const boxW_4x6 = 307; // 幅4cm
  const boxH_4x6 = 461; // 高さ6cm

  if (mode === 'free') {
    targetH = Math.max(1, Math.round(sourceImage.height * (WIDTH_PX / sourceImage.width)));
  } else if (mode === 'fixed-fit' || mode === 'fixed-crop') {
    targetH = 230; // 5×3 cm
  } else if (mode === 'fixed-4x6-fit' || mode === 'fixed-4x6-crop') {
    targetH = boxH_4x6; // 4×6 cm
  }

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
  } else if (mode === 'fixed-4x6-fit') {
    // 4×6 cm 全体表示（左右反転）: 4x6cm枠内に収まるよう縮小して中央配置
    const scale = Math.min(boxW_4x6 / sourceImage.width, boxH_4x6 / sourceImage.height);
    const dw = Math.round(sourceImage.width * scale);
    const dh = Math.round(sourceImage.height * scale);
    const dx = Math.round((WIDTH_PX - dw) / 2);
    const dy = Math.round((targetH - dh) / 2);

    ctx.translate(WIDTH_PX, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(sourceImage, dx, dy, dw, dh);
  } else if (mode === 'fixed-4x6-crop') {
    // 4×6 cm 上下位置調整（左右反転）: 幅4cm(307px)に横幅を合わせ、余剰高さをスライダーで調整
    const scale = boxW_4x6 / sourceImage.width;
    const dh = Math.round(sourceImage.height * scale);
    const overflow = dh - boxH_4x6;
    const offset = parseInt(offsetRange.value, 10) / 100;
    const dy = overflow > 0 ? -Math.round(overflow * offset) : Math.round((boxH_4x6 - dh) / 2);
    const dx = Math.round((WIDTH_PX - boxW_4x6) / 2);

    ctx.translate(WIDTH_PX, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(sourceImage, dx, dy, boxW_4x6, dh);
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

  const img = new Image();
  img.onload = () => {
    if (currentToken !== loadCounter) {
      if (isBlob) URL.revokeObjectURL(src);
      return;
    }
    if (currentBlobUrl && currentBlobUrl !== src) {
      URL.revokeObjectURL(currentBlobUrl);
    }
    currentBlobUrl = isBlob ? src : null;
    sourceImage = img;
    renderAndProcess();
    setStatus('印刷準備完了');
  };

  img.onerror = () => {
    if (currentToken !== loadCounter) {
      if (isBlob) URL.revokeObjectURL(src);
      return;
    }
    if (isBlob) URL.revokeObjectURL(src);
    setStatus('画像の読み込みに失敗しました');
    updateUI();
  };

  img.src = src;
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
  const isCrop = (modeSelect.value === 'fixed-crop' || modeSelect.value === 'fixed-4x6-crop');
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
