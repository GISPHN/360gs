// 360GS c23 delivery helpers.
// Training remains unchanged from c22. This module only handles local export
// and viewer state serialization.

const VIEW_VERSION = 1;
const VIEW_KEY = 'view';

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function round(v, digits = 6) {
  if (!Number.isFinite(v)) return 0;
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(text) {
  const pad = text.length % 4 ? '='.repeat(4 - (text.length % 4)) : '';
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function normalizeViewState(state) {
  if (!state || typeof state !== 'object') return null;
  const mode = state.mode === 'look' ? 'look' : 'orbit';
  const out = {
    v: VIEW_VERSION,
    mode,
    yaw: round(finite(Number(state.yaw))),
    pitch: round(Math.max(-1.55, Math.min(1.55, finite(Number(state.pitch))))),
    distanceRatio: round(Math.max(0.001, finite(Number(state.distanceRatio), 2.35))),
    fov: round(Math.max(15, Math.min(120, finite(Number(state.fov), 55))), 4)
  };
  if (mode === 'look' && Array.isArray(state.lookPosRatio) && state.lookPosRatio.length === 3) {
    const p = state.lookPosRatio.map(v => round(finite(Number(v))));
    if (p.every(Number.isFinite)) out.lookPosRatio = p;
  }
  return out;
}

export function encodeViewState(state) {
  const normalized = normalizeViewState(state);
  if (!normalized) return '';
  return `${VIEW_KEY}=${base64UrlEncode(JSON.stringify(normalized))}`;
}

export function decodeViewState(hash = globalThis.location?.hash || '') {
  try {
    const raw = String(hash || '').replace(/^#/, '');
    const params = new URLSearchParams(raw);
    const encoded = params.get(VIEW_KEY);
    if (!encoded) return null;
    const data = JSON.parse(base64UrlDecode(encoded));
    if (data?.v !== VIEW_VERSION) return null;
    return normalizeViewState(data);
  } catch {
    return null;
  }
}

export function buildViewerUrl({ src = '', name = '', state = null, base = globalThis.location?.href || '' } = {}) {
  const url = new URL('./viewer.html', base);
  if (src) url.searchParams.set('src', src);
  if (name) url.searchParams.set('name', name);
  const encoded = encodeViewState(state);
  if (encoded) url.hash = encoded;
  return url.toString();
}

export function brushDataToSpzCloud(source, extensions = []) {
  if (!source || !Number.isFinite(source.count) || source.count < 1) throw new Error('SPZへ変換するGaussianがありません。');
  const n = source.count | 0;
  const degree = Math.max(0, Math.min(4, source.degree | 0));
  const nc = (degree + 1) ** 2;
  const shDim = Math.max(0, nc - 1);
  const t = source.transforms;
  const h = source.shCoeffs;
  const o = source.rawOpacities;
  if (!(t instanceof Float32Array) || t.length < n * 10) throw new Error('Gaussian transform配列が不足しています。');
  if (!(h instanceof Float32Array) || h.length < n * nc * 3) throw new Error('Gaussian SH配列が不足しています。');
  if (!(o instanceof Float32Array) || o.length < n) throw new Error('Gaussian opacity配列が不足しています。');

  const positions = new Float32Array(n * 3);
  const scales = new Float32Array(n * 3);
  const rotations = new Float32Array(n * 4); // SPZ: x, y, z, w
  const alphas = new Float32Array(n);
  const colors = new Float32Array(n * 3);    // SH DC coefficients
  const sh = new Float32Array(n * shDim * 3);

  for (let i = 0; i < n; i++) {
    const z = i * 10;
    const s = i * nc * 3;
    positions[i * 3] = finite(t[z]);
    positions[i * 3 + 1] = finite(t[z + 1]);
    positions[i * 3 + 2] = finite(t[z + 2]);
    scales[i * 3] = finite(t[z + 7]);
    scales[i * 3 + 1] = finite(t[z + 8]);
    scales[i * 3 + 2] = finite(t[z + 9]);

    const qw = finite(t[z + 3], 1);
    const qx = finite(t[z + 4]);
    const qy = finite(t[z + 5]);
    const qz = finite(t[z + 6]);
    const qn = Math.hypot(qw, qx, qy, qz) || 1;
    rotations[i * 4] = qx / qn;
    rotations[i * 4 + 1] = qy / qn;
    rotations[i * 4 + 2] = qz / qn;
    rotations[i * 4 + 3] = qw / qn;

    alphas[i] = finite(o[i]);
    colors[i * 3] = finite(h[s]);
    colors[i * 3 + 1] = finite(h[s + 1]);
    colors[i * 3 + 2] = finite(h[s + 2]);

    for (let c = 1; c < nc; c++) {
      const dst = (i * shDim + (c - 1)) * 3;
      const src = s + c * 3;
      sh[dst] = finite(h[src]);
      sh[dst + 1] = finite(h[src + 1]);
      sh[dst + 2] = finite(h[src + 2]);
    }
  }

  return {
    numPoints: n,
    shDegree: degree,
    antialiased: false,
    extensions,
    positions,
    scales,
    rotations,
    alphas,
    colors,
    sh
  };
}

let spzModulePromise = null;
async function getSpzModule() {
  if (!spzModulePromise) {
    spzModulePromise = import('./vendor/spz/dist/spz.js').then(async m => {
      const create = m.default;
      if (typeof create !== 'function') throw new Error('SPZ WASMモジュールを読み込めません。');
      return create();
    });
  }
  return spzModulePromise;
}

export async function encodeSpzV4(source, { bounds = null } = {}) {
  const mod = await getSpzModule();
  const extensions = [];
  if (typeof mod.SpzHasExtensionSupport === 'function' && mod.SpzHasExtensionSupport() && mod.SpzExtensionSafeOrbitCameraAdobe) {
    try {
      const safe = new mod.SpzExtensionSafeOrbitCameraAdobe();
      safe.safeOrbitElevationMin = -1.45;
      safe.safeOrbitElevationMax = 1.45;
      safe.safeOrbitRadiusMin = Math.max(1e-5, Number(bounds?.radius || 1) * 0.08);
      extensions.push(safe);
    } catch {
      // The SPZ file remains valid without optional extensions.
    }
  }

  const cloud = brushDataToSpzCloud(source, extensions);
  const version = Math.max(4, Number(mod.LATEST_SPZ_HEADER_VERSION || 4));
  const bytes = mod.saveSpzToBuffer(cloud, {
    version,
    // Brush/standard 3DGS PLY camera data are Right-Down-Front.
    // SPZ internally converts this to its canonical storage coordinates.
    from: mod.CoordinateSystem.RDF,
    sh1Bits: 5,
    shRestBits: 4
  });
  if (!bytes || !bytes.byteLength) throw new Error('SPZ v4のエンコードに失敗しました。');
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 8 || String.fromCharCode(...u8.subarray(0, 4)) !== 'NGSP') throw new Error('生成したSPZヘッダーを検証できません。');
  const fileVersion = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
  if (fileVersion < 4) throw new Error(`SPZ v4ではない出力が生成されました（version ${fileVersion}）。`);
  return new Blob([u8], { type: 'application/octet-stream' });
}
