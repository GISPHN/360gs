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

  return { numPoints: n, shDegree: degree, antialiased: false, extensions, positions, scales, rotations, alphas, colors, sh };
}

const PLY_TYPE_SIZE = { char:1, uchar:1, int8:1, uint8:1, short:2, ushort:2, int16:2, uint16:2, int:4, uint:4, int32:4, uint32:4, float:4, float32:4, double:8, float64:8 };

function readPlyScalar(view, offset, type) {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, true);
    case 'ushort': case 'uint16': return view.getUint16(offset, true);
    case 'int': case 'int32': return view.getInt32(offset, true);
    case 'uint': case 'uint32': return view.getUint32(offset, true);
    case 'float': case 'float32': return view.getFloat32(offset, true);
    case 'double': case 'float64': return view.getFloat64(offset, true);
    default: throw new Error(`未対応のPLY型です: ${type}`);
  }
}

export async function parseGaussianPly(blob) {
  if (!(blob instanceof Blob)) throw new Error('PLY Blobを取得できません。');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const probeLength = Math.min(bytes.length, 256 * 1024);
  const probe = new TextDecoder('utf-8').decode(bytes.subarray(0, probeLength));
  const marker = 'end_header\n';
  const markerIndex = probe.indexOf(marker);
  if (markerIndex < 0) throw new Error('PLYヘッダーの終端を検出できません。');
  const headerText = probe.slice(0, markerIndex + marker.length);
  if (!/^ply\s/m.test(headerText) || !/format binary_little_endian 1\.0/.test(headerText)) throw new Error('binary little endian PLYのみSPZへ変換できます。');
  const headerBytes = new TextEncoder().encode(headerText).byteLength;
  const lines = headerText.split(/\r?\n/);
  let vertexCount = 0;
  let inVertex = false;
  const props = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'element') {
      inVertex = parts[1] === 'vertex';
      if (inVertex) vertexCount = Number(parts[2]);
    } else if (inVertex && parts[0] === 'property') {
      if (parts[1] === 'list') throw new Error('vertex list propertyを含むPLYには未対応です。');
      const type = parts[1], name = parts[2];
      const size = PLY_TYPE_SIZE[type];
      if (!size) throw new Error(`未対応のPLY property型です: ${type}`);
      props.push({ type, name, size });
    }
  }
  if (!Number.isFinite(vertexCount) || vertexCount < 1 || !props.length) throw new Error('PLYのGaussian数またはpropertyを取得できません。');
  let rowSize = 0;
  const offsets = new Map();
  for (const prop of props) { offsets.set(prop.name, { ...prop, offset: rowSize }); rowSize += prop.size; }
  if (headerBytes + rowSize * vertexCount > bytes.byteLength) throw new Error('PLYバイナリ本体がヘッダー記載サイズより短いです。');
  const required = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
  for (const name of required) if (!offsets.has(name)) throw new Error(`3DGS PLY property ${name} がありません。`);
  const restNames = props.map(p => p.name).filter(n => /^f_rest_\d+$/.test(n));
  const shDim = restNames.length / 3;
  if (!Number.isInteger(shDim) || ![0,3,8,15,24].includes(shDim)) throw new Error(`SH property数がSPZ仕様と一致しません (${restNames.length})。`);
  const degree = shDim === 0 ? 0 : shDim === 3 ? 1 : shDim === 8 ? 2 : shDim === 15 ? 3 : 4;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const positions = new Float32Array(vertexCount * 3);
  const scales = new Float32Array(vertexCount * 3);
  const rotations = new Float32Array(vertexCount * 4);
  const alphas = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 3);
  const sh = new Float32Array(vertexCount * shDim * 3);
  const get = (base, name) => { const p = offsets.get(name); return readPlyScalar(view, base + p.offset, p.type); };
  for (let i = 0; i < vertexCount; i++) {
    const base = headerBytes + i * rowSize;
    positions.set([get(base,'x'),get(base,'y'),get(base,'z')], i * 3);
    scales.set([get(base,'scale_0'),get(base,'scale_1'),get(base,'scale_2')], i * 3);
    const qw=get(base,'rot_0'),qx=get(base,'rot_1'),qy=get(base,'rot_2'),qz=get(base,'rot_3'),qn=Math.hypot(qw,qx,qy,qz)||1;
    rotations.set([qx/qn,qy/qn,qz/qn,qw/qn], i * 4);
    alphas[i] = get(base,'opacity');
    colors.set([get(base,'f_dc_0'),get(base,'f_dc_1'),get(base,'f_dc_2')], i * 3);
    for (let ch = 0; ch < 3; ch++) for (let c = 0; c < shDim; c++) {
      sh[(i * shDim + c) * 3 + ch] = get(base, `f_rest_${ch * shDim + c}`);
    }
  }
  return { numPoints: vertexCount, shDegree: degree, antialiased: false, extensions: [], positions, scales, rotations, alphas, colors, sh };
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

async function encodeCloudSpzV4(cloud, { bounds = null } = {}) {
  const mod = await getSpzModule();
  const extensions = [];
  if (typeof mod.SpzHasExtensionSupport === 'function' && mod.SpzHasExtensionSupport() && mod.SpzExtensionSafeOrbitCameraAdobe) {
    try {
      const safe = new mod.SpzExtensionSafeOrbitCameraAdobe();
      safe.safeOrbitElevationMin = -1.45;
      safe.safeOrbitElevationMax = 1.45;
      safe.safeOrbitRadiusMin = Math.max(1e-5, Number(bounds?.radius || 1) * 0.08);
      extensions.push(safe);
    } catch {}
  }
  cloud.extensions = extensions;
  const bytes = mod.saveSpzToBuffer(cloud, {
    version: 4,
    from: mod.CoordinateSystem.RDF,
    sh1Bits: 5,
    shRestBits: 4
  });
  if (!bytes || !bytes.byteLength) throw new Error('SPZ v4のエンコードに失敗しました。');
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength < 8 || String.fromCharCode(...u8.subarray(0, 4)) !== 'NGSP') throw new Error('生成したSPZヘッダーを検証できません。');
  const fileVersion = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(4, true);
  if (fileVersion !== 4) throw new Error(`SPZ v4ではない出力が生成されました（version ${fileVersion}）。`);
  return new Blob([u8], { type: 'application/octet-stream' });
}

export async function encodeSpzV4(source, options = {}) {
  return encodeCloudSpzV4(brushDataToSpzCloud(source), options);
}

export async function encodePlyToSpzV4(blob, options = {}) {
  const cloud = await parseGaussianPly(blob);
  return encodeCloudSpzV4(cloud, options);
}
