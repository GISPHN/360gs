import * as pc from 'playcanvas';
import { SpzParser } from './vendor/playcanvas-spz/spz-parser.mjs';
import { buildViewerUrl, decodeViewState, normalizeViewState } from './delivery.js?v=0.3c25';

const canvas = document.querySelector('#viewer-canvas');
const wrap = document.querySelector('.canvas-wrap');
const fileInput = document.querySelector('#viewer-file');
const urlInput = document.querySelector('#viewer-url');
const loadUrlButton = document.querySelector('#viewer-load-url');
const fitButton = document.querySelector('#viewer-fit');
const copyButton = document.querySelector('#viewer-copy');
const status = document.querySelector('#viewer-status');
const message = document.querySelector('#viewer-message');

function msg(text, kind = '') {
  message.hidden = !text;
  message.className = `message${kind ? ` ${kind}` : ''}`;
  message.textContent = text || '';
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function finite3(v) { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite); }

let device;
let app;
let camera = null;
let entity = null;
let asset = null;
let objectUrl = null;
let sourceUrl = '';
let sourceName = '';
let center = [0, 0, 0];
let radius = 1;
let mode = 'orbit';
let yaw = 0.55;
let pitch = 0.12;
let distance = 2.35;
let lookPos = [0, 0, 0];
let fov = 55;
let drag = false;
let pointerId = null;
let lastX = 0;
let lastY = 0;

function cameraComponent() {
  const component = camera?.camera;
  if (!component) throw new Error('WebGL viewerのCameraComponentを初期化できませんでした。ページを再読み込みしてください。');
  return component;
}

function direction() {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}

function setClips() {
  const cc = cameraComponent();
  cc.nearClip = Math.max(radius * 0.00002, 0.00001);
  cc.farClip = Math.max(radius * 100, distance + radius * 20, 100);
}

function updateCamera() {
  if (!camera) return;
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || !Number.isFinite(distance) || !finite3(lookPos)) {
    fit();
    return;
  }
  const cc = cameraComponent();
  pitch = clamp(pitch, -1.45, 1.45);
  if (mode === 'look') {
    const d = direction();
    cc.fov = clamp(fov, 20, 110);
    camera.setPosition(lookPos[0], lookPos[1], lookPos[2]);
    camera.lookAt(
      lookPos[0] + d[0] * Math.max(radius, 1),
      lookPos[1] + d[1] * Math.max(radius, 1),
      lookPos[2] + d[2] * Math.max(radius, 1)
    );
  } else {
    distance = clamp(distance, Math.max(radius * 0.08, 0.0001), Math.max(radius * 40, 1));
    cc.fov = 55;
    const cp = Math.cos(pitch);
    camera.setPosition(
      center[0] + distance * Math.sin(yaw) * cp,
      center[1] + distance * Math.sin(pitch),
      center[2] + distance * Math.cos(yaw) * cp
    );
    camera.lookAt(center[0], center[1], center[2]);
  }
  setClips();
}

function fit() {
  mode = 'orbit';
  yaw = 0.55;
  pitch = 0.12;
  const halfFov = 55 * Math.PI / 360;
  const sphereFit = radius / Math.max(0.05, Math.sin(halfFov));
  distance = Math.max(radius * 1.25, sphereFit * 1.06);
  fov = 55;
  updateCamera();
}

function currentViewState() {
  return normalizeViewState({
    mode,
    yaw,
    pitch,
    distanceRatio: distance / Math.max(radius, 1e-8),
    fov: mode === 'look' ? fov : 55,
    lookPosRatio: mode === 'look'
      ? lookPos.map((v, i) => (v - center[i]) / Math.max(radius, 1e-8))
      : undefined
  });
}

function applyViewState(state) {
  if (!state) { fit(); return; }
  mode = state.mode === 'look' ? 'look' : 'orbit';
  yaw = state.yaw;
  pitch = state.pitch;
  distance = Math.max(radius * 0.001, state.distanceRatio * radius);
  fov = state.fov;
  if (mode === 'look' && Array.isArray(state.lookPosRatio)) {
    lookPos = state.lookPosRatio.map((v, i) => center[i] + v * radius);
  }
  updateCamera();
}

async function init() {
  try {
    device = await pc.createGraphicsDevice(canvas, {
      deviceTypes: [pc.DEVICETYPE_WEBGL2],
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance'
    });
    device.maxPixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);

    const options = new pc.AppOptions();
    options.graphicsDevice = device;
    options.componentSystems = [
      pc.RenderComponentSystem,
      pc.CameraComponentSystem,
      pc.GSplatComponentSystem
    ];
    options.resourceHandlers = [pc.TextureHandler, pc.GSplatHandler];

    app = new pc.AppBase(canvas);
    app.init(options);

    pc.WasmModule.setConfig('ZstdDecoderModule', {
      glueUrl: './vendor/playcanvas-spz/zstd.wasm.js',
      wasmUrl: './vendor/playcanvas-spz/zstd.wasm.wasm'
    });
    const handler = app.loader.getHandler('gsplat');
    if (!handler) throw new Error('PlayCanvas GSplat handlerを初期化できませんでした。');
    handler.addParser(new SpzParser(app));

    // Create the camera only after AppBase has registered CameraComponentSystem.
    // Creating the Entity before app.init() can leave entity.camera undefined
    // when a model load immediately restores a viewpoint and writes camera.fov.
    camera = new pc.Entity('Camera');
    camera.addComponent('camera', {
      clearColor: new pc.Color(0.07, 0.08, 0.10),
      fov: 55,
      nearClip: 0.0001,
      farClip: 100000
    });
    if (!camera.camera) throw new Error('CameraComponentの登録に失敗しました。');
    app.root.addChild(camera);

    app.start();
    status.textContent = 'WebGL 2 / WebGPU不要';
    status.className = 'status';
    resize();
  } catch (e) {
    status.textContent = 'WebGL 2を利用できません';
    msg(`WebGL 2 viewerを初期化できません: ${e?.message || e}`);
    throw e;
  }
}

function clearScene() {
  if (entity) { entity.destroy(); entity = null; }
  if (asset) { app.assets.remove(asset); asset.unload?.(); asset = null; }
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
}

async function loadModel(src, name = '360gs.spz', { local = false } = {}) {
  if (!app || !camera?.camera) {
    msg('WebGL viewerの初期化が完了していません。少し待ってからもう一度選択してください。');
    return;
  }
  clearScene();
  msg('3DGSを読み込んでいます。');
  sourceUrl = local ? '' : src;
  sourceName = name || '360gs.spz';
  try {
    asset = new pc.Asset('360GS', 'gsplat', { url: src, filename: sourceName });
    app.assets.add(asset);
    await new Promise((resolve, reject) => {
      asset.once('load', resolve);
      asset.once('error', reject);
      app.assets.load(asset);
    });
    entity = new pc.Entity('3DGS');
    entity.addComponent('gsplat', { asset });
    app.root.addChild(entity);

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bb = asset.resource?.aabb || entity.gsplat?.instance?.meshInstance?.aabb;
    if (bb) {
      center = [bb.center.x, bb.center.y, bb.center.z];
      radius = Math.max(1e-4, Math.hypot(bb.halfExtents.x, bb.halfExtents.y, bb.halfExtents.z));
    } else {
      center = [0, 0, 0];
      radius = 1;
    }
    const shared = decodeViewState(location.hash);
    applyViewState(shared);
    msg(`${sourceName} をWebGL 2で表示しています。`, 'success');
  } catch (e) {
    msg(`3DGSを読み込めません: ${e?.message || e}`);
    clearScene();
  }
}

async function loadFile(file) {
  if (!file) return;
  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.ply') && !lower.endsWith('.spz')) {
    msg('PLYまたはSPZ v4ファイルを選択してください。');
    return;
  }
  const u = URL.createObjectURL(file);
  await loadModel(u, file.name, { local: true });
  if (entity) objectUrl = u;
  else URL.revokeObjectURL(u);
}

async function copyViewUrl() {
  if (!entity) { msg('先に3DGSを表示してください。'); return; }
  const external = sourceUrl && !sourceUrl.startsWith('blob:') ? sourceUrl : '';
  const url = buildViewerUrl({ src: external, name: sourceName, state: currentViewState(), base: location.href });
  try {
    await navigator.clipboard.writeText(url);
    if (external) msg('モデルURLと現在の視点をコピーしました。', 'success');
    else msg('現在の視点設定をURLへコピーしました。ローカルモデル本体は別端末には含まれません。', 'success');
  } catch {
    prompt('このURLをコピーしてください', url);
  }
}

function resize() {
  if (!app || !wrap) return;
  const r = wrap.getBoundingClientRect();
  app.resizeCanvas(Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height)));
}

canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  drag = true;
  pointerId = e.pointerId;
  lastX = e.clientX;
  lastY = e.clientY;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
});
canvas.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== pointerId) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  if (Math.abs(dx) + Math.abs(dy) < 0.01) return;
  yaw -= dx * 0.006;
  pitch = clamp(pitch - dy * 0.006, -1.45, 1.45);
  updateCamera();
});
const endDrag = e => {
  if (pointerId !== null && e.pointerId !== pointerId) return;
  drag = false;
  pointerId = null;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', () => { drag = false; pointerId = null; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (!camera?.camera) return;
  if (mode === 'look') fov = clamp(fov * Math.exp(e.deltaY * 0.001), 20, 110);
  else distance = clamp(distance * Math.exp(e.deltaY * 0.001), Math.max(radius * 0.08, 0.0001), Math.max(radius * 40, 1));
  updateCamera();
}, { passive: false });

fileInput.addEventListener('change', () => loadFile(fileInput.files?.[0]));
loadUrlButton.addEventListener('click', () => {
  const src = urlInput.value.trim();
  if (!src) { msg('表示するPLY / SPZ URLを入力してください。'); return; }
  let name = new URL(src, location.href).pathname.split('/').pop() || '360gs.spz';
  if (!/\.(ply|spz)$/i.test(name)) name = '360gs.spz';
  loadModel(src, name, { local: false });
});
fitButton.addEventListener('click', () => {
  if (!camera?.camera) { msg('WebGL viewerの初期化が完了していません。'); return; }
  fit();
});
copyButton.addEventListener('click', copyViewUrl);
new ResizeObserver(resize).observe(wrap);

await init();
const params = new URLSearchParams(location.search);
const initialSrc = params.get('src');
const initialName = params.get('name') || '';
if (initialSrc) {
  urlInput.value = initialSrc;
  await loadModel(initialSrc, initialName || new URL(initialSrc, location.href).pathname.split('/').pop() || '360gs.spz');
} else {
  fit();
  msg('PLYまたはSPZ v4を選択してください。');
}
