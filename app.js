// C50 サーマルプリンター規格定数 (LPC50_95A5 ESC/POS)
const WIDTH_PX = 384;
const WIDTH_BYTES = 48; // 1行あたり48バイト
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
const imageSettingsCard = document.getElementById('imageSettingsCard');
const textListContainer = document.getElementById('textListContainer');
const btnAddRow = document.getElementById('btnAddRow');
const btnClearText = document.getElementById('btnClearText');

let bleDevice = null;
let writeChar = null;
let isPrinting = false;
let currentTab = 'tab-paste'; // 'tab-paste' | 'tab-file' | 'tab-text'
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
// タブ切り替え制御
// =============================================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isPrinting) return;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    btn.classList.add('active');
    currentTab = btn.getAttribute('data-tab');
    document.getElementById(currentTab).classList.add('active');

    // 画像設定カードの表示制御（文字入力時は非表示）
    imageSettingsCard.style.display = (currentTab === 'tab-text') ? 'none' : 'block';

    if (currentTab === 'tab-text') {
      renderTextList();
    } else {
      if (sourceImage) renderAndProcessImage();
    }
  });
});

// =============================================================================
// 文字入力（箇条書き・可変行・自動文字サイズ均一化）
// =============================================================================
let textItems = [''];

function renderTextInputs() {
  textListContainer.innerHTML = '';
  textItems.forEach((val, idx) => {
    const row = document.createElement('div');
    row.className = 'text-item-row';

    const bullet = document.createElement('span');
    bullet.textContent = '・';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-item-input';
    input.placeholder = `項目 ${idx + 1}`;
    input.value = val;
    input.addEventListener('input', (e) => {
      textItems[idx] = e.target.value;
      renderTextList();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove-row';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      if (textItems.length > 1) {
        textItems.splice(idx, 1);
        renderTextInputs();
        renderTextList();
      } else {
        textItems[0] = '';
        renderTextInputs();
        renderTextList();
      }
    });

    row.appendChild(bullet);
    row.appendChild(input);
    row.appendChild(removeBtn);
    textListContainer.appendChild(row);
  });
}

btnAddRow.addEventListener('click', () => {
  textItems.push('');
  renderTextInputs();
  const inputs = textListContainer.querySelectorAll('.text-item-input');
  if (inputs.length) inputs[inputs.length - 1].focus();
});

btnClearText.addEventListener('click', () => {
  textItems = [''];
  renderTextInputs();
  renderTextList();
});

// 文字列リストをCanvasに描画（最長文字数に応じて文字サイズを全体均一自動リサイズ、高さ自動可変）
function renderTextList() {
  const activeItems = textItems.map(t => t.trim()).filter(t => t.length > 0);
  if (activeItems.length === 0) {
    canvas.width = WIDTH_PX;
    canvas.height = 80;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, WIDTH_PX, 80);
    ctx.fillStyle = '#adb5bd';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('文字を入力してください', WIDTH_PX / 2, 45);
    cachedRaster = null;
    updateUI();
    return;
  }

  // 利用可能な最大横幅 (384px - 左右マージン 32px - 中点スペース 24px)
  const maxContentW = WIDTH_PX - 56;

  // 1. 最長項目の長さに応じて文字サイズ（フォントサイズ）を自動算出
  // 基本最大フォントサイズ: 28px、最小フォントサイズ: 14px
  let fontSize = 28;
  ctx.font = `bold ${fontSize}px sans-serif`;

  let maxItemWidth = 0;
  activeItems.forEach(item => {
    const w = ctx.measureText(item).width;
    if (w > maxItemWidth) maxItemWidth = w;
  });

  if (maxItemWidth > maxContentW) {
    fontSize = Math.max(14, Math.floor(fontSize * (maxContentW / maxItemWidth)));
  }

  // 2. 行の高さと余白の計算
  const lineHeight = Math.round(fontSize * 1.55);
  const paddingY = 24;
  const targetH = Math.max(80, (paddingY * 2) + (activeItems.length * lineHeight));

  canvas.width = WIDTH_PX;
  canvas.height = targetH;

  // 背景白塗り
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, WIDTH_PX, targetH);

  // 文字描画（高コントラスト黒）
  ctx.fillStyle = '#000000';
  ctx.font = `bold ${fontSize}px "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  const startX = 24;
  activeItems.forEach((item, index) => {
    const y = paddingY + (index * lineHeight) + (lineHeight / 2);
    // 箇条書き中点
    ctx.fillText('・', startX, y);
    // 項目テキスト
    ctx.fillText(item, startX + fontSize + 4, y, maxContentW);
  });

  // ラスタ変換処理
  packCanvasToRaster(targetH);
  setStatus('印刷準備完了 (文字リスト)');
}

// 初期入力欄生成
renderTextInputs();

// =============================================================================
// ペースト処理（画像バイナリ / Discord等の画像リンク両対応）
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

  // 2. HTML形式貼り付け内の img タグ
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
function renderAndProcessImage() {
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

  packCanvasToRaster(targetH);
  setStatus('印刷準備完了 (画像)');
}

// Canvasの内容を2値化・ディザリングしてESC/POSラスタ配列へパック
function packCanvasToRaster(h) {
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
          renderAndProcessImage();
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
// Bluetooth 通信制御 (1行48バイト固定同期送信)
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
    const data = cachedRaster.subarray(8);
    const totalBytes = data.length;

    for (let offset = 0; offset < totalBytes; offset += WIDTH_BYTES) {
      if (!bleDevice?.gatt?.connected) throw new Error('通信が切断されました');

      const lineChunk = data.subarray(offset, offset + WIDTH_BYTES);
      await sendRawChunk(lineChunk);
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
  if (sourceImage) renderAndProcessImage();
};

offsetRange.oninput = () => {
  const v = parseInt(offsetRange.value, 10);
  offsetVal.textContent = (v === 0) ? '上寄り' : (v === 50) ? '中央' : (v === 100) ? '下寄り' : (v + '%');
  if (sourceImage) renderAndProcessImage();
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
