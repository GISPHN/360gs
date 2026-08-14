const fileInput = document.querySelector('#video-input');
const dropZone = document.querySelector('#video-drop-zone');
const message = document.querySelector('#video-message');
const analysisPanel = document.querySelector('#analysis-panel');
const fileNameEl = document.querySelector('#video-name');
const fileMetaEl = document.querySelector('#video-meta');
const frameGrid = document.querySelector('#frame-grid');
const progressBar = document.querySelector('#progress-bar');
const progressText = document.querySelector('#progress-text');
const statusList = document.querySelector('#status-list');
const chooseAgainButton = document.querySelector('#choose-again');
const video = document.querySelector('#source-video');
const canvas = document.querySelector('#capture-canvas');

let currentUrl = null;
let frameUrls = [];

const MAX_FRAMES = 12;
const PREVIEW_WIDTH = 960;

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index >= 2 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes ? `${minutes}分${rest}秒` : `${rest}秒`;
}

function clearFrames() {
  frameUrls.forEach((url) => URL.revokeObjectURL(url));
  frameUrls = [];
  frameGrid.replaceChildren();
}

function cleanup() {
  clearFrames();
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  video.removeAttribute('src');
  video.load();
}

function showMessage(type, text) {
  message.className = `message-box ${type}`;
  message.textContent = text;
  message.hidden = false;
}

function hideMessage() {
  message.hidden = true;
  message.textContent = '';
  message.className = 'message-box';
}

function setProgress(value, text) {
  const clamped = Math.max(0, Math.min(100, value));
  progressBar.style.width = `${clamped}%`;
  progressBar.parentElement.setAttribute('aria-valuenow', String(Math.round(clamped)));
  progressText.textContent = text;
}

function waitForEvent(target, eventName, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanupListeners();
      reject(new Error('動画の読み込みに時間がかかりすぎています。'));
    }, timeout);

    const onSuccess = () => {
      cleanupListeners();
      resolve();
    };

    const onError = () => {
      cleanupListeners();
      reject(new Error('この動画をブラウザで読み込めませんでした。Insta360 StudioからMP4で書き出して、もう一度お試しください。'));
    };

    const cleanupListeners = () => {
      window.clearTimeout(timer);
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener('error', onError);
    };

    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

async function seekVideo(time) {
  if (Math.abs(video.currentTime - time) < 0.01) return;
  const promise = waitForEvent(video, 'seeked', 8000);
  video.currentTime = time;
  await promise;
}

function chooseTimes(duration) {
  const count = Math.max(4, Math.min(MAX_FRAMES, Math.ceil(duration / 4)));
  const start = duration * 0.03;
  const end = duration * 0.97;
  if (count === 1 || end <= start) return [Math.max(0, duration / 2)];
  return Array.from({ length: count }, (_, index) => start + (end - start) * (index / (count - 1)));
}

async function captureFrame(time, index, total) {
  await seekVideo(time);

  const ratio = video.videoWidth / video.videoHeight;
  const width = Math.min(PREVIEW_WIDTH, video.videoWidth);
  const height = Math.round(width / ratio);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(video, 0, 0, width, height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  if (!blob) throw new Error('代表画像を作成できませんでした。');

  const url = URL.createObjectURL(blob);
  frameUrls.push(url);

  const figure = document.createElement('figure');
  figure.className = 'frame-card';

  const image = document.createElement('img');
  image.src = url;
  image.alt = `${time.toFixed(1)}秒の代表画像`;
  image.loading = 'lazy';

  const caption = document.createElement('figcaption');
  caption.textContent = `${time.toFixed(1)} 秒`;

  figure.append(image, caption);
  frameGrid.append(figure);

  const percent = 35 + ((index + 1) / total) * 60;
  setProgress(percent, `代表画像を作っています (${index + 1}/${total})`);
}

function renderStatus({ ratioOk, resolutionOk, durationOk, width, height, duration }) {
  const rows = [
    {
      ok: ratioOk,
      label: ratioOk ? '360°動画の形：2:1として認識しました' : '360°動画の形：2:1ではない可能性があります',
    },
    {
      ok: resolutionOk,
      label: resolutionOk ? `解像度：${width.toLocaleString()} × ${height.toLocaleString()} px` : `解像度：${width.toLocaleString()} × ${height.toLocaleString()} px（低めです）`,
    },
    {
      ok: durationOk,
      label: durationOk ? `動画の長さ：${formatDuration(duration)}` : `動画の長さ：${formatDuration(duration)}（短すぎる可能性があります）`,
    },
  ];

  statusList.replaceChildren();
  rows.forEach((row) => {
    const item = document.createElement('div');
    item.className = `status-row ${row.ok ? 'ok' : 'warn'}`;
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    const label = document.createElement('span');
    label.textContent = row.label;
    item.append(dot, label);
    statusList.append(item);
  });
}

function supportedVideo(file) {
  return file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
}

async function analyzeVideo(file) {
  hideMessage();
  analysisPanel.hidden = true;
  clearFrames();

  if (!file || !supportedVideo(file)) {
    showMessage('error', '動画ファイルを選んでください。Insta360 Studioから書き出したMP4を推奨します。');
    return;
  }

  cleanup();
  currentUrl = URL.createObjectURL(file);
  video.src = currentUrl;
  video.preload = 'metadata';

  setProgress(8, '動画を確認しています');

  try {
    await waitForEvent(video, 'loadedmetadata', 15000);

    const width = video.videoWidth;
    const height = video.videoHeight;
    const duration = video.duration;

    if (!width || !height || !Number.isFinite(duration) || duration <= 0) {
      throw new Error('動画の大きさや長さを確認できませんでした。');
    }

    const ratio = width / height;
    const ratioOk = Math.abs(ratio - 2) <= 0.18;
    const resolutionOk = width >= 1920 && height >= 960;
    const durationOk = duration >= 5;

    fileNameEl.textContent = file.name;
    fileMetaEl.textContent = `${width.toLocaleString()} × ${height.toLocaleString()} px ・ ${formatDuration(duration)} ・ ${formatBytes(file.size)}`;
    renderStatus({ ratioOk, resolutionOk, durationOk, width, height, duration });
    analysisPanel.hidden = false;

    if (!ratioOk) {
      setProgress(100, '確認が必要です');
      showMessage('warning', 'この動画は一般的な2:1の360°動画ではない可能性があります。Insta360 Studioから360° equirectangular MP4として書き出した動画を推奨します。');
      return;
    }

    setProgress(32, '代表画像を準備しています');
    const times = chooseTimes(duration);
    for (let index = 0; index < times.length; index += 1) {
      await captureFrame(times[index], index, times.length);
    }

    setProgress(100, '素材の確認が完了しました');

    if (resolutionOk && durationOk) {
      showMessage('success', '3D化の次工程に進める形式として認識しました。次の開発段階で、この代表画像から撮影位置を自動推定します。');
    } else {
      showMessage('warning', '360°動画として読み込めましたが、3D化には素材が不足する可能性があります。できれば5秒以上、より高い解像度で撮影してください。');
    }
  } catch (error) {
    setProgress(0, '読み込みできませんでした');
    analysisPanel.hidden = true;
    showMessage('error', error?.message || '動画を確認できませんでした。');
  }
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => analyzeVideo(fileInput.files?.[0]));
chooseAgainButton.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) analyzeVideo(file);
});

window.addEventListener('beforeunload', cleanup);
