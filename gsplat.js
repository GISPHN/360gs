import {
  Application,
  Asset,
  Color,
  Entity,
  FILLMODE_NONE,
  RESOLUTION_AUTO,
} from 'playcanvas';

const input = document.querySelector('#gsplat-input');
const dropZone = document.querySelector('#gsplat-drop-zone');
const message = document.querySelector('#gsplat-message');
const sampleButton = document.querySelector('#sample-button');
const startPanel = document.querySelector('#start-panel');
const viewerPanel = document.querySelector('#viewer-panel');
const stage = document.querySelector('#gsplat-stage');
const fileName = document.querySelector('#gsplat-file-name');
const fileMeta = document.querySelector('#gsplat-file-meta');
const chooseAnother = document.querySelector('#choose-another');
const resetButton = document.querySelector('#reset-3d-view');
const loading = document.querySelector('#gsplat-loading');
const loadingText = document.querySelector('#gsplat-loading-text');

const SAMPLE_URL = 'https://developer.playcanvas.com/assets/toy-cat.sog';

let app = null;
let canvas = null;
let currentUrl = null;
let currentUrlOwned = false;
let resizeObserver = null;
let controlsCleanup = null;
let resetCamera = null;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index >= 2 ? 1 : 0)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showMessage(type, html) {
  message.className = `message-box ${type}`;
  message.innerHTML = html;
  message.hidden = false;
}

function clearMessage() {
  message.hidden = true;
  message.textContent = '';
  message.className = 'message-box';
}

function setLoading(show, text = '3D空間を読み込んでいます') {
  loadingText.textContent = text;
  loading.hidden = !show;
}

function isSupported(file) {
  const name = file?.name?.toLowerCase() || '';
  return name.endsWith('.ply') || name.endsWith('.sog');
}

function destroyViewer() {
  if (controlsCleanup) {
    controlsCleanup();
    controlsCleanup = null;
  }
  resetCamera = null;

  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  if (app) {
    app.destroy();
    app = null;
  }

  if (currentUrlOwned && currentUrl) {
    URL.revokeObjectURL(currentUrl);
  }
  currentUrl = null;
  currentUrlOwned = false;
  canvas = null;
  stage.replaceChildren();
}

function resizeCanvas() {
  if (!app) return;
  const width = Math.max(1, Math.floor(stage.clientWidth));
  const height = Math.max(1, Math.floor(stage.clientHeight));
  app.resizeCanvas(width, height);
}

function installOrbitControls(camera, initialDistance) {
  let yaw = 0;
  let pitch = 0.06;
  let distance = initialDistance;
  const minDistance = Math.max(initialDistance * 0.04, 0.001);
  const maxDistance = Math.max(initialDistance * 25, minDistance * 2);
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let activePointer = null;

  function updateCamera() {
    const cosPitch = Math.cos(pitch);
    const x = distance * Math.sin(yaw) * cosPitch;
    const y = distance * Math.sin(pitch);
    const z = distance * Math.cos(yaw) * cosPitch;
    camera.setPosition(x, y, z);
    camera.lookAt(0, 0, 0);
  }

  function reset() {
    yaw = 0;
    pitch = 0.06;
    distance = initialDistance;
    updateCamera();
  }

  function pointerDown(event) {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    dragging = true;
    activePointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event) {
    if (!dragging || event.pointerId !== activePointer) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    yaw -= dx * 0.006;
    pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * 0.006));
    updateCamera();
  }

  function pointerUp(event) {
    if (event.pointerId !== activePointer) return;
    dragging = false;
    activePointer = null;
    try { canvas.releasePointerCapture?.(event.pointerId); } catch {}
  }

  function wheel(event) {
    event.preventDefault();
    distance *= Math.exp(event.deltaY * 0.0012);
    distance = Math.max(minDistance, Math.min(maxDistance, distance));
    updateCamera();
  }

  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  canvas.addEventListener('wheel', wheel, { passive: false });

  updateCamera();
  resetCamera = reset;

  return () => {
    canvas?.removeEventListener('pointerdown', pointerDown);
    canvas?.removeEventListener('pointermove', pointerMove);
    canvas?.removeEventListener('pointerup', pointerUp);
    canvas?.removeEventListener('pointercancel', pointerUp);
    canvas?.removeEventListener('wheel', wheel);
  };
}

async function loadSplatSource({ displayName, filename, url, size = null, ownedUrl = false, sample = false }) {
  clearMessage();
  destroyViewer();

  currentUrl = url;
  currentUrlOwned = ownedUrl;
  startPanel.hidden = true;
  viewerPanel.hidden = false;
  fileName.textContent = displayName;
  fileMeta.textContent = sample ? 'PlayCanvas公式サンプル' : formatBytes(size);
  setLoading(true, sample ? 'サンプル3Dを読み込んでいます' : '3D空間を読み込んでいます');

  try {
    canvas = document.createElement('canvas');
    canvas.className = 'gsplat-canvas';
    canvas.setAttribute('aria-label', '3D Gaussian Splatting viewer');
    stage.appendChild(canvas);

    app = new Application(canvas, {
      graphicsDeviceOptions: {
        antialias: false,
        alpha: false,
      },
    });

    const width = Math.max(1, Math.floor(stage.clientWidth));
    const height = Math.max(1, Math.floor(stage.clientHeight));
    app.setCanvasFillMode(FILLMODE_NONE, width, height);
    app.setCanvasResolution(RESOLUTION_AUTO);
    app.start();

    const camera = new Entity('Camera');
    camera.addComponent('camera', {
      clearColor: new Color(0.055, 0.067, 0.086),
      fov: 55,
      nearClip: 0.001,
      farClip: 10000,
    });
    app.root.addChild(camera);

    const asset = new Asset(displayName, 'gsplat', {
      url,
      filename,
      size: Number.isFinite(size) ? size : undefined,
    });
    app.assets.add(asset);

    await new Promise((resolve, reject) => {
      asset.once('load', resolve);
      asset.once('error', (error) => reject(error instanceof Error ? error : new Error(String(error || '3DGSを読み込めませんでした。'))));
      app.assets.load(asset);
    });

    const splat = new Entity('3DGS');
    splat.addComponent('gsplat', { asset });
    app.root.addChild(splat);

    const aabb = asset.resource?.aabb;
    let radius = 1.5;

    if (aabb?.center && aabb?.halfExtents) {
      const center = aabb.center;
      const half = aabb.halfExtents;
      splat.setPosition(-center.x, -center.y, -center.z);
      const measuredRadius = Math.hypot(half.x, half.y, half.z);
      if (Number.isFinite(measuredRadius) && measuredRadius > 0) radius = measuredRadius;
    }

    camera.camera.nearClip = Math.max(radius * 0.002, 0.0001);
    camera.camera.farClip = Math.max(radius * 100, 1000);
    const initialDistance = Math.max(radius * 2.35, 0.1);
    controlsCleanup = installOrbitControls(camera, initialDistance);

    resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(stage);
    resizeCanvas();
    setLoading(false);
  } catch (error) {
    const detail = escapeHtml(error?.message || 'このファイルを3DGSとして読み込めませんでした。');
    destroyViewer();
    viewerPanel.hidden = true;
    startPanel.hidden = false;
    setLoading(false);
    showMessage(
      'error',
      `3D空間を開けませんでした。<br>${detail}<br><br>` +
      `通常の3DメッシュPLYではなく、Gaussian Splattingで作成されたPLY・Compressed PLY・SOGを選んでください。`
    );
  }
}

async function openLocalFile(file) {
  clearMessage();
  if (!file) return;

  if (!isSupported(file)) {
    showMessage('warning', 'このファイル形式にはまだ対応していません。<br>PLY、Compressed PLY、SOGの3DGSファイルを選んでください。');
    return;
  }

  const url = URL.createObjectURL(file);
  await loadSplatSource({
    displayName: file.name,
    filename: file.name,
    url,
    size: file.size,
    ownedUrl: true,
  });
}

input.addEventListener('change', () => openLocalFile(input.files?.[0]));
dropZone.addEventListener('click', () => input.click());

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragging');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragging');
  openLocalFile(event.dataTransfer?.files?.[0]);
});

sampleButton.addEventListener('click', () => {
  loadSplatSource({
    displayName: 'サンプル3D（toy-cat）',
    filename: 'toy-cat.sog',
    url: SAMPLE_URL,
    sample: true,
  });
});

chooseAnother.addEventListener('click', () => {
  destroyViewer();
  setLoading(false);
  input.value = '';
  viewerPanel.hidden = true;
  startPanel.hidden = false;
  clearMessage();
});

resetButton.addEventListener('click', () => resetCamera?.());
window.addEventListener('beforeunload', destroyViewer);
