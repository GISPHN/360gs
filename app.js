window.__360gsReady = true;
import { Viewer } from '@photo-sphere-viewer/core';

const screens = {
  home: document.querySelector('#home-screen'),
  upload: document.querySelector('#upload-screen'),
  viewer: document.querySelector('#viewer-screen'),
};

const openPanoramaButton = document.querySelector('#open-panorama-button');
const panoramaInput = document.querySelector('#panorama-input');
const dropZone = document.querySelector('#drop-zone');
const fileMessage = document.querySelector('#file-message');
const viewerElement = document.querySelector('#viewer');
const viewerTitle = document.querySelector('#viewer-title');
const viewerMeta = document.querySelector('#viewer-meta');
const viewerBackButton = document.querySelector('#viewer-back-button');
const resetViewButton = document.querySelector('#reset-view-button');
const environmentStatus = document.querySelector('#environment-status');
const recheckButton = document.querySelector('#recheck-button');
const loadingOverlay = document.querySelector('#loading-overlay');
const loadingText = document.querySelector('#loading-text');

let viewer = null;
let currentObjectUrl = null;

function showScreen(name) {
  Object.entries(screens).forEach(([key, element]) => {
    element.classList.toggle('active', key === name);
  });
}

function setMessage(type, html) {
  fileMessage.className = `message-box ${type}`;
  fileMessage.innerHTML = html;
  fileMessage.hidden = false;
}

function clearMessage() {
  fileMessage.hidden = true;
  fileMessage.textContent = '';
  fileMessage.className = 'message-box';
}

function setLoading(show, text = '写真を確認しています') {
  loadingText.textContent = text;
  loadingOverlay.hidden = !show;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index >= 2 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function isSupportedImage(file) {
  const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
  if (supportedTypes.has(file.type)) return true;
  return /\.(jpe?g|png|webp)$/i.test(file.name);
}

function readImageDimensions(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    image.src = url;
  });
}

function cleanupViewer() {
  if (viewer) {
    viewer.destroy();
    viewer = null;
  }
  viewerElement.replaceChildren();
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

async function openPanorama(file) {
  clearMessage();

  if (!file) return;
  if (!isSupportedImage(file)) {
    setMessage('error', 'このファイル形式にはまだ対応していません。<br>JPEG、PNG、WebPの360°写真を選んでください。');
    return;
  }

  setLoading(true, '写真を確認しています');

  const objectUrl = URL.createObjectURL(file);

  try {
    const { width, height } = await readImageDimensions(objectUrl);
    if (!width || !height) throw new Error('画像サイズを確認できませんでした。');

    const ratio = width / height;
    const ratioDifference = Math.abs(ratio - 2);

    if (ratioDifference > 0.18) {
      URL.revokeObjectURL(objectUrl);
      setLoading(false);
      setMessage(
        'warning',
        `この画像は360°写真ではない可能性があります。<br>` +
        `画像サイズは ${width.toLocaleString()} × ${height.toLocaleString()} px です。<br>` +
        `Insta360 Studioなどから「360°写真」として書き出した、横幅が高さの約2倍の画像を選んでください。`
      );
      return;
    }

    cleanupViewer();
    currentObjectUrl = objectUrl;

    showScreen('viewer');
    viewerTitle.textContent = file.name;
    viewerMeta.textContent = `${width.toLocaleString()} × ${height.toLocaleString()} px ・ ${formatBytes(file.size)}`;

    setLoading(true, '360°表示を準備しています');

    viewer = new Viewer({
      container: viewerElement,
      panorama: currentObjectUrl,
      caption: '',
      description: '',
      navbar: ['zoom', 'move', 'fullscreen'],
      defaultYaw: 0,
      defaultPitch: 0,
      defaultZoomLvl: 35,
      mousewheelCtrlKey: false,
      touchmoveTwoFingers: false,
      rendererParameters: {
        antialias: true,
        alpha: true,
      },
    });

    viewer.addEventListener('ready', () => {
      setLoading(false);
    }, { once: true });

    window.setTimeout(() => setLoading(false), 5000);
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    setLoading(false);
    showScreen('upload');
    setMessage('error', `写真を開けませんでした。<br>${escapeHtml(error?.message || '別の写真を選んでください。')}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function checkEnvironment() {
  const webgl = (() => {
    try {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch {
      return false;
    }
  })();

  const fileApi = Boolean(window.File && window.FileReader && window.Blob && window.URL);
  const webGpu = 'gpu' in navigator;
  const browser = navigator.userAgentData?.brands?.map((item) => item.brand).join(', ') || navigator.userAgent;

  const rows = [
    { ok: fileApi, label: fileApi ? '写真の読み込み：利用できます' : '写真の読み込み：このブラウザでは利用できません' },
    { ok: webgl, label: webgl ? '360°表示：利用できます' : '360°表示：この端末では利用できない可能性があります' },
    { ok: webGpu, warn: !webGpu, label: webGpu ? '将来の3D生成：WebGPUを利用できます' : '将来の3D生成：WebGPUが見つかりません（360°写真は利用可能です）' },
  ];

  environmentStatus.innerHTML = '';
  rows.forEach((row) => {
    const div = document.createElement('div');
    div.className = `status-row ${row.ok ? 'ok' : 'warn'}`;
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    const text = document.createElement('span');
    text.textContent = row.label;
    div.append(dot, text);
    environmentStatus.append(div);
  });

  environmentStatus.dataset.browser = browser;
}

openPanoramaButton.addEventListener('click', () => {
  clearMessage();
  showScreen('upload');
});

document.querySelectorAll('[data-back-home]').forEach((button) => {
  button.addEventListener('click', () => {
    clearMessage();
    showScreen('home');
  });
});

dropZone.addEventListener('click', () => panoramaInput.click());
panoramaInput.addEventListener('change', () => openPanorama(panoramaInput.files?.[0]));

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  openPanorama(event.dataTransfer?.files?.[0]);
});

viewerBackButton.addEventListener('click', () => {
  cleanupViewer();
  panoramaInput.value = '';
  clearMessage();
  showScreen('upload');
});

resetViewButton.addEventListener('click', () => {
  if (!viewer) return;
  viewer.animate({ yaw: 0, pitch: 0, zoom: 35, speed: 650 });
});

recheckButton.addEventListener('click', checkEnvironment);
window.addEventListener('beforeunload', cleanupViewer);

checkEnvironment();
