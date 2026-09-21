// --- 1. Service Worker の登録 ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('Service Worker 登録成功:', reg.scope))
      .catch((err) => console.error('Service Worker 登録失敗:', err));
  });
}

// --- 2. PWA インストールプロンプトの制御 ---
let deferredPrompt;
const installBtn = document.getElementById('install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = 'block';
});

installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  console.log(`ユーザーの選択: ${outcome}`);
  deferredPrompt = null;
  installBtn.style.display = 'none';
});

window.addEventListener('appinstalled', () => {
  console.log('PWA が正常にインストールされました');
  installBtn.style.display = 'none';
});

// --- 3. C50 プリンター (Web Bluetooth) 通信制御 ---
let printerDevice = null;
let printCharacteristic = null;

const connectBtn = document.getElementById('connect-btn');
const printBtn = document.getElementById('print-btn');
const statusDiv = document.getElementById('connection-status');
const printTextInput = document.getElementById('print-text');

connectBtn.addEventListener('click', async () => {
  if (!navigator.bluetooth) {
    alert('お使いのブラウザは Web Bluetooth に対応していません。Android 版 Chrome をお使いください。');
    return;
  }

  try {
    statusDiv.textContent = '接続先を検索中...';

    printerDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        '0000e781-0000-1000-8000-00805f9b34fb',
        '000018f0-0000-1000-8000-00805f9b34fb',
        '49535343-fe7d-4ae5-8fa9-9fafd205e455',
        'e7810a71-73ae-499d-8c15-faa9aef0c3f2'
      ]
    });

    statusDiv.textContent = 'GATT サーバーに接続中...';
    const server = await printerDevice.gatt.connect();

    const services = await server.getPrimaryServices();
    for (const service of services) {
      const characteristics = await service.getCharacteristics();
      for (const char of characteristics) {
        if (char.properties.write || char.properties.writeWithoutResponse) {
          printCharacteristic = char;
          break;
        }
      }
      if (printCharacteristic) break;
    }

    if (!printCharacteristic) {
      throw new Error('書き込み可能な Characteristic が見つかりませんでした。');
    }

    statusDiv.textContent = `接続完了: ${printerDevice.name || 'C50 Printer'}`;
    statusDiv.style.color = '#2e7d32';
    printBtn.disabled = false;
    connectBtn.disabled = true;

  } catch (error) {
    console.error('Bluetooth 接続エラー:', error);
    statusDiv.textContent = `接続失敗: ${error.message}`;
    statusDiv.style.color = '#d32f2f';
  }
});

// ESC/POS コマンドによる印刷
printBtn.addEventListener('click', async () => {
  if (!printCharacteristic) return;

  const text = printTextInput.value || 'Hello C50 Pocket Printer!\n';
  const encoder = new TextEncoder();
  
  // 初期化 (ESC @) + テキスト + 改行・給紙 (ESC d 3)
  const initCmd = new Uint8Array([0x1B, 0x40]);
  const textBytes = encoder.encode(text + '\n');
  const feedCmd = new Uint8Array([0x1B, 0x64, 0x03]);

  const payload = new Uint8Array(initCmd.length + textBytes.length + feedCmd.length);
  payload.set(initCmd, 0);
  payload.set(textBytes, initCmd.length);
  payload.set(feedCmd, initCmd.length + textBytes.length);

  try {
    const CHUNK_SIZE = 100;
    for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
      const chunk = payload.slice(i, i + CHUNK_SIZE);
      if (printCharacteristic.properties.writeWithoutResponse) {
        await printCharacteristic.writeValueWithoutResponse(chunk);
      } else {
        await printCharacteristic.writeValueWithResponse(chunk);
      }
    }
  } catch (err) {
    console.error('印刷エラー:', err);
    alert('印刷中にエラーが発生しました: ' + err.message);
  }
});
