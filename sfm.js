const sfmSourceVideo = document.querySelector('#source-video');
const sfmProgressText = document.querySelector('#progress-text');

let sfmGeneration = 0;
let sfmRunning = false;
let sfmLastSignature = '';
let sfmPerspectiveMaps = null;

const SFM_EQ_WIDTH = 640;
const SFM_EQ_HEIGHT = 320;
const SFM_VIEW_SIZE = 176;
const SFM_FOV_DEG = 100;
const SFM_VIEW_YAWS = [0, 90, 180, 270];
const SFM_MAX_FEATURES = 96;
const SFM_MIN_DISTANCE = 7;
const SFM_PATCH_OFFSETS = [-5, -2, 0, 2, 5];
const SFM_MIN_CORRESPONDENCES = 12;
const SFM_MAX_CORRESPONDENCES = 180;
const SFM_RANSAC_ITERS = 84;
const SFM_EPIPOLAR_THRESHOLD = 0.020;
const SFM_MIN_INLIER_RATIO = 0.28;
const SFM_GOOD_INLIER_RATIO = 0.42;
const SFM_MIN_PARALLAX_DEG = 0.18;
const SFM_GOOD_PARALLAX_DEG = 0.40;
const SFM_MAX_PARALLAX_DEG = 35;
const SFM_MAX_TOTAL_FRAMES = 72;
const SFM_MAX_POINTS = 1600;

const sfmWorkCanvas = document.createElement('canvas');

function sfmMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sfmClamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function sfmNorm3(v) { return Math.hypot(v[0], v[1], v[2]); }
function sfmNormalize3(v) { const n = sfmNorm3(v); return !Number.isFinite(n) || n < 1e-12 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n]; }
function sfmDot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function sfmCross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function sfmScale3(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
function sfmAdd3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function sfmSub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function sfmIdentity3() { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
function sfmTranspose3(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
function sfmMatVec3(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }
function sfmMul3(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return out;
}
function sfmDet3(m) { return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]); }
function sfmMatrixFromColumns(c0, c1, c2) { return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]]; }
function sfmGetColumn(m, column) { return [m[column], m[3 + column], m[6 + column]]; }

function sfmJacobiEigenSymmetric(input, n, maxIterations = 220, tolerance = 1e-11) {
  const a = Array.from(input);
  const vectors = new Array(n * n).fill(0);
  for (let i = 0; i < n; i += 1) vectors[i * n + i] = 1;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let p = 0, q = 1, maxValue = 0;
    for (let r = 0; r < n; r += 1) for (let c = r + 1; c < n; c += 1) {
      const value = Math.abs(a[r * n + c]);
      if (value > maxValue) { maxValue = value; p = r; q = c; }
    }
    if (maxValue < tolerance) break;
    const app = a[p * n + p], aqq = a[q * n + q], apq = a[p * n + q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app), c = Math.cos(phi), s = Math.sin(phi);
    for (let k = 0; k < n; k += 1) {
      if (k === p || k === q) continue;
      const akp = a[k * n + p], akq = a[k * n + q];
      const kp = c * akp - s * akq, kq = s * akp + c * akq;
      a[k * n + p] = kp; a[p * n + k] = kp; a[k * n + q] = kq; a[q * n + k] = kq;
    }
    a[p * n + p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q * n + q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p * n + q] = 0; a[q * n + p] = 0;
    for (let k = 0; k < n; k += 1) {
      const vkp = vectors[k * n + p], vkq = vectors[k * n + q];
      vectors[k * n + p] = c * vkp - s * vkq;
      vectors[k * n + q] = s * vkp + c * vkq;
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), vectors };
}

function sfmSvd3(matrix) {
  const mtm = sfmMul3(sfmTranspose3(matrix), matrix);
  const eigen = sfmJacobiEigenSymmetric(mtm, 3, 90, 1e-12);
  const order = [0, 1, 2].sort((a, b) => eigen.values[b] - eigen.values[a]);
  const col = (index) => [eigen.vectors[index], eigen.vectors[3 + index], eigen.vectors[6 + index]];
  let v0 = sfmNormalize3(col(order[0]));
  let v1 = sfmNormalize3(sfmSub3(col(order[1]), sfmScale3(v0, sfmDot3(col(order[1]), v0))));
  let v2 = sfmNormalize3(sfmCross3(v0, v1));
  if (sfmNorm3(v0) < 0.5 || sfmNorm3(v1) < 0.5 || sfmNorm3(v2) < 0.5) return null;
  const singular = order.map((i) => Math.sqrt(Math.max(0, eigen.values[i])));
  if (singular[0] < 1e-10 || singular[1] < 1e-10) return null;
  let u0 = sfmNormalize3(sfmScale3(sfmMatVec3(matrix, v0), 1 / singular[0]));
  let u1Raw = sfmScale3(sfmMatVec3(matrix, v1), 1 / singular[1]);
  let u1 = sfmNormalize3(sfmSub3(u1Raw, sfmScale3(u0, sfmDot3(u1Raw, u0))));
  let u2 = sfmNormalize3(sfmCross3(u0, u1));
  if (sfmNorm3(u0) < 0.5 || sfmNorm3(u1) < 0.5 || sfmNorm3(u2) < 0.5) return null;
  if (sfmDot3(v2, sfmNormalize3(col(order[2]))) < 0) { v2 = sfmScale3(v2, -1); u2 = sfmScale3(u2, -1); }
  return { u: sfmMatrixFromColumns(u0, u1, u2), v: sfmMatrixFromColumns(v0, v1, v2), singular };
}

function sfmEnforceEssential(matrix) {
  const svd = sfmSvd3(matrix); if (!svd) return null;
  const s = (svd.singular[0] + svd.singular[1]) / 2;
  return sfmMul3(sfmMul3(svd.u, [s, 0, 0, 0, s, 0, 0, 0, 0]), sfmTranspose3(svd.v));
}

function sfmFitEssential(correspondences) {
  if (correspondences.length < 8) return null;
  const ata = new Float64Array(81);
  for (const corr of correspondences) {
    const a = corr.leftBearing, b = corr.rightBearing;
    const row = [b[0] * a[0], b[0] * a[1], b[0] * a[2], b[1] * a[0], b[1] * a[1], b[1] * a[2], b[2] * a[0], b[2] * a[1], b[2] * a[2]];
    for (let r = 0; r < 9; r += 1) for (let c = r; c < 9; c += 1) ata[r * 9 + c] += row[r] * row[c];
  }
  for (let r = 0; r < 9; r += 1) for (let c = 0; c < r; c += 1) ata[r * 9 + c] = ata[c * 9 + r];
  const eigen = sfmJacobiEigenSymmetric(ata, 9, 240, 1e-10);
  let minIndex = 0; for (let i = 1; i < 9; i += 1) if (eigen.values[i] < eigen.values[minIndex]) minIndex = i;
  const raw = Array.from({ length: 9 }, (_, r) => eigen.vectors[r * 9 + minIndex]);
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return norm < 1e-12 ? null : sfmEnforceEssential(raw.map((value) => value / norm));
}

function sfmEpipolarResidual(E, corr) {
  const ea = sfmMatVec3(E, corr.leftBearing), etb = sfmMatVec3(sfmTranspose3(E), corr.rightBearing);
  return Math.abs(sfmDot3(corr.rightBearing, ea)) / Math.max(1e-9, Math.sqrt(sfmDot3(ea, ea) + sfmDot3(etb, etb)));
}

function sfmMakeRng(seed) { let state = (seed >>> 0) || 0x9e3779b9; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) + 1) / 4294967297; }; }
function sfmSampleEight(count, rng) { const chosen = new Set(); while (chosen.size < 8 && chosen.size < count) chosen.add(Math.floor(rng() * count)); return Array.from(chosen); }

function sfmRansacEssential(correspondences, seed) {
  if (correspondences.length < SFM_MIN_CORRESPONDENCES) return null;
  const usable = [...correspondences].sort((a, b) => a.quality - b.quality).slice(0, SFM_MAX_CORRESPONDENCES);
  const rng = sfmMakeRng(seed); let best = null;
  for (let iteration = 0; iteration < SFM_RANSAC_ITERS; iteration += 1) {
    const indices = sfmSampleEight(usable.length, rng); if (indices.length < 8) break;
    const E = sfmFitEssential(indices.map((i) => usable[i])); if (!E) continue;
    const inliers = [], residuals = []; let cost = 0;
    for (const corr of usable) { const residual = sfmEpipolarResidual(E, corr); cost += Math.min(residual * residual, SFM_EPIPOLAR_THRESHOLD * SFM_EPIPOLAR_THRESHOLD); if (residual <= SFM_EPIPOLAR_THRESHOLD) { inliers.push(corr); residuals.push(residual); } }
    if (inliers.length < 8) continue;
    if (!best || cost < best.cost || (Math.abs(cost - best.cost) < 1e-12 && inliers.length > best.inliers.length)) best = { E, inliers, residuals, cost };
  }
  if (!best) return null;
  const refined = sfmFitEssential(best.inliers); if (!refined) return null;
  const finalInliers = [], finalResiduals = [];
  for (const corr of usable) { const residual = sfmEpipolarResidual(refined, corr); if (residual <= SFM_EPIPOLAR_THRESHOLD) { finalInliers.push(corr); finalResiduals.push(residual); } }
  if (finalInliers.length < 8) return null;
  return { essential: refined, inliers: finalInliers, total: usable.length, inlierRatio: finalInliers.length / Math.max(1, usable.length), medianResidual: sfmMedian(finalResiduals) };
}

function sfmDecomposeEssential(E) {
  const svd = sfmSvd3(E); if (!svd) return [];
  let u = svd.u, v = svd.v;
  if (sfmDet3(u) < 0) u = sfmMatrixFromColumns(sfmGetColumn(u, 0), sfmGetColumn(u, 1), sfmScale3(sfmGetColumn(u, 2), -1));
  if (sfmDet3(v) < 0) v = sfmMatrixFromColumns(sfmGetColumn(v, 0), sfmGetColumn(v, 1), sfmScale3(sfmGetColumn(v, 2), -1));
  const w = [0, -1, 0, 1, 0, 0, 0, 0, 1], vt = sfmTranspose3(v);
  let r1 = sfmMul3(sfmMul3(u, w), vt), r2 = sfmMul3(sfmMul3(u, sfmTranspose3(w)), vt);
  const t = sfmNormalize3(sfmGetColumn(u, 2));
  if (sfmDet3(r1) < 0) r1 = r1.map((x) => -x); if (sfmDet3(r2) < 0) r2 = r2.map((x) => -x);
  return [{ rotation: r1, translation: t }, { rotation: r1, translation: sfmScale3(t, -1) }, { rotation: r2, translation: t }, { rotation: r2, translation: sfmScale3(t, -1) }];
}

function sfmTriangulateRays(c1, d1, c2, d2) {
  const r = sfmSub3(c1, c2), a = sfmDot3(d1, d1), b = sfmDot3(d1, d2), c = sfmDot3(d2, d2), d = sfmDot3(d1, r), e = sfmDot3(d2, r);
  const denom = a * c - b * b; if (Math.abs(denom) < 1e-7) return null;
  const l1 = (b * e - c * d) / denom, l2 = (a * e - b * d) / denom;
  if (l1 <= 0 || l2 <= 0) return null;
  const p1 = sfmAdd3(c1, sfmScale3(d1, l1)), p2 = sfmAdd3(c2, sfmScale3(d2, l2));
  const error = sfmNorm3(sfmSub3(p1, p2));
  if (!Number.isFinite(error) || error > 0.35) return null;
  return { point: sfmScale3(sfmAdd3(p1, p2), 0.5), error, depth1: l1, depth2: l2 };
}

function sfmCheirality(candidate, correspondences) {
  const rt = sfmTranspose3(candidate.rotation), cameraCenter = sfmScale3(sfmMatVec3(rt, candidate.translation), -1);
  let positive = 0, usable = 0; const errors = [];
  for (const corr of correspondences.slice(0, 100)) {
    const d1 = corr.leftBearing, d2 = sfmNormalize3(sfmMatVec3(rt, corr.rightBearing));
    const tri = sfmTriangulateRays([0, 0, 0], d1, cameraCenter, d2); if (!tri) continue;
    usable += 1; positive += 1; errors.push(tri.error);
  }
  return { positive, usable, ratio: positive / Math.max(1, usable), medianError: sfmMedian(errors), cameraCenter: sfmNormalize3(cameraCenter) };
}

function sfmRotationAngle(rotation) { return Math.acos(sfmClamp((rotation[0] + rotation[4] + rotation[8] - 1) / 2, -1, 1)) * 180 / Math.PI; }
function sfmParallax(rotation, correspondences) { const rt = sfmTranspose3(rotation); return sfmMedian(correspondences.map((corr) => Math.acos(sfmClamp(sfmDot3(corr.leftBearing, sfmNormalize3(sfmMatVec3(rt, corr.rightBearing))), -1, 1)) * 180 / Math.PI)); }

function sfmEstimateRelative(correspondences, seed) {
  const model = sfmRansacEssential(correspondences, seed);
  if (!model) return { success: false, state: 'weak', inlierRatio: 0, parallaxDeg: 0, inlierCorrs: [] };
  const candidates = sfmDecomposeEssential(model.essential); let best = null;
  for (const candidate of candidates) { const cheirality = sfmCheirality(candidate, model.inliers); if (!best || cheirality.positive > best.cheirality.positive || (cheirality.positive === best.cheirality.positive && cheirality.medianError < best.cheirality.medianError)) best = { candidate, cheirality }; }
  if (!best) return { success: false, state: 'weak', inlierRatio: model.inlierRatio, parallaxDeg: 0, inlierCorrs: [] };
  const parallaxDeg = sfmParallax(best.candidate.rotation, model.inliers), rotationDeg = sfmRotationAngle(best.candidate.rotation), cheiralityRatio = best.cheirality.ratio;
  const saneParallax = parallaxDeg >= SFM_MIN_PARALLAX_DEG && parallaxDeg <= SFM_MAX_PARALLAX_DEG;
  let state = 'weak';
  if (model.inlierRatio >= SFM_GOOD_INLIER_RATIO && cheiralityRatio >= 0.5 && saneParallax && parallaxDeg >= SFM_GOOD_PARALLAX_DEG) state = 'good';
  else if (model.inlierRatio >= SFM_MIN_INLIER_RATIO && cheiralityRatio >= 0.30 && saneParallax) state = 'attention';
  return { success: state !== 'weak', state, rotation: best.candidate.rotation, translationDirection: best.cheirality.cameraCenter, inlierRatio: model.inlierRatio, inliers: model.inliers.length, correspondences: model.total, parallaxDeg, rotationDeg, cheiralityRatio, inlierCorrs: model.inliers };
}

function sfmGetPerspectiveMaps() {
  if (sfmPerspectiveMaps) return sfmPerspectiveMaps;
  const maps = [], halfFov = Math.tan((SFM_FOV_DEG * Math.PI / 180) / 2);
  for (const yawDeg of SFM_VIEW_YAWS) {
    const yaw = yawDeg * Math.PI / 180, cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw), map = new Uint32Array(SFM_VIEW_SIZE * SFM_VIEW_SIZE);
    for (let y = 0; y < SFM_VIEW_SIZE; y += 1) for (let x = 0; x < SFM_VIEW_SIZE; x += 1) {
      const nx = ((x + 0.5) / SFM_VIEW_SIZE * 2 - 1) * halfFov, ny = ((y + 0.5) / SFM_VIEW_SIZE * 2 - 1) * halfFov, len = Math.hypot(nx, -ny, 1);
      const vx = nx / len, vy = -ny / len, vz = 1 / len, worldX = vx * cosYaw + vz * sinYaw, worldZ = -vx * sinYaw + vz * cosYaw;
      const longitude = Math.atan2(worldX, worldZ), latitude = Math.asin(sfmClamp(vy, -1, 1));
      let sx = Math.floor((longitude / (2 * Math.PI) + 0.5) * SFM_EQ_WIDTH); sx = ((sx % SFM_EQ_WIDTH) + SFM_EQ_WIDTH) % SFM_EQ_WIDTH;
      const sy = sfmClamp(Math.floor((0.5 - latitude / Math.PI) * SFM_EQ_HEIGHT), 0, SFM_EQ_HEIGHT - 1);
      map[y * SFM_VIEW_SIZE + x] = sy * SFM_EQ_WIDTH + sx;
    }
    maps.push(map);
  }
  sfmPerspectiveMaps = maps; return maps;
}

async function sfmSeek(time) {
  if (!sfmSourceVideo || !Number.isFinite(sfmSourceVideo.duration)) throw new Error('動画を確認できません。');
  const bounded = sfmClamp(time, 0, Math.max(0, sfmSourceVideo.duration - 0.001));
  if (Math.abs(sfmSourceVideo.currentTime - bounded) < 0.01) return;
  await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { clean(); reject(new Error('局所SfM用フレームの読み込みに時間がかかっています。')); }, 10000);
    const ok = () => { clean(); resolve(); }, err = () => { clean(); reject(new Error('動画フレームを読み込めませんでした。')); }, clean = () => { clearTimeout(timer); sfmSourceVideo.removeEventListener('seeked', ok); sfmSourceVideo.removeEventListener('error', err); };
    sfmSourceVideo.addEventListener('seeked', ok, { once: true }); sfmSourceVideo.addEventListener('error', err, { once: true }); sfmSourceVideo.currentTime = bounded;
  });
}

async function sfmCapturePanorama(time) {
  await sfmSeek(time); sfmWorkCanvas.width = SFM_EQ_WIDTH; sfmWorkCanvas.height = SFM_EQ_HEIGHT;
  const ctx = sfmWorkCanvas.getContext('2d', { alpha: false, willReadFrequently: true }); ctx.drawImage(sfmSourceVideo, 0, 0, SFM_EQ_WIDTH, SFM_EQ_HEIGHT);
  const data = ctx.getImageData(0, 0, SFM_EQ_WIDTH, SFM_EQ_HEIGHT).data, gray = new Uint8Array(SFM_EQ_WIDTH * SFM_EQ_HEIGHT);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) gray[p] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  return gray;
}
function sfmProject(gray, map) { const out = new Uint8Array(map.length); for (let i = 0; i < map.length; i += 1) out[i] = gray[map[i]]; return out; }
function sfmCorner(gray, size, x, y) { let a = 0, b = 0, c = 0; for (let dy = -2; dy <= 2; dy += 1) { const row = (y + dy) * size; for (let dx = -2; dx <= 2; dx += 1) { const px = x + dx, gx = gray[row + px + 1] - gray[row + px - 1], gy = gray[row + size + px] - gray[row - size + px]; a += gx * gx; b += gy * gy; c += gx * gy; } } const trace = a + b; return (trace - Math.sqrt(Math.max(0, (a - b) * (a - b) + 4 * c * c))) / 2; }
function sfmDescriptor(gray, size, x, y) { const raw = new Float32Array(SFM_PATCH_OFFSETS.length ** 2); let mean = 0, i = 0; for (const dy of SFM_PATCH_OFFSETS) for (const dx of SFM_PATCH_OFFSETS) { const v = gray[(y + dy) * size + x + dx]; raw[i++] = v; mean += v; } mean /= raw.length; let variance = 0; for (const v of raw) variance += (v - mean) ** 2; const std = Math.sqrt(variance / raw.length); if (std < 8) return null; for (let k = 0; k < raw.length; k += 1) raw[k] = (raw[k] - mean) / std; return raw; }
function sfmDetect(gray) { const candidates = [], margin = 8; for (let y = margin; y < SFM_VIEW_SIZE - margin; y += 3) for (let x = margin; x < SFM_VIEW_SIZE - margin; x += 3) { const response = sfmCorner(gray, SFM_VIEW_SIZE, x, y); if (response > 1650) candidates.push({ x, y, response }); } candidates.sort((a, b) => b.response - a.response); const features = []; for (const c of candidates) { if (features.some((e) => (c.x - e.x) ** 2 + (c.y - e.y) ** 2 < SFM_MIN_DISTANCE ** 2)) continue; const descriptor = sfmDescriptor(gray, SFM_VIEW_SIZE, c.x, c.y); if (!descriptor) continue; features.push({ ...c, descriptor }); if (features.length >= SFM_MAX_FEATURES) break; } return features; }
function sfmDescriptorDistance(a, b) { let sum = 0; for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; sum += d * d; } return sum; }
function sfmNearestTwo(feature, targets) { let bestIndex = -1, best = Infinity, second = Infinity; for (let i = 0; i < targets.length; i += 1) { const distance = sfmDescriptorDistance(feature.descriptor, targets[i].descriptor); if (distance < best) { second = best; best = distance; bestIndex = i; } else if (distance < second) second = distance; } return { bestIndex, best, second }; }
function sfmMatchViews(left, right) { if (left.length < 6 || right.length < 6) return []; const f = left.map((x) => sfmNearestTwo(x, right)), r = right.map((x) => sfmNearestTwo(x, left)), matches = []; f.forEach((m, li) => { if (m.bestIndex < 0 || !Number.isFinite(m.second) || m.best > m.second * 0.77) return; const back = r[m.bestIndex]; if (!back || back.bestIndex !== li || !Number.isFinite(back.second) || back.best > back.second * 0.81) return; matches.push({ leftX: left[li].x, leftY: left[li].y, rightX: right[m.bestIndex].x, rightY: right[m.bestIndex].y, distance: m.best }); }); return matches; }
function sfmBearing(x, y, yawDeg) { const halfFov = Math.tan((SFM_FOV_DEG * Math.PI / 180) / 2), nx = ((x + 0.5) / SFM_VIEW_SIZE * 2 - 1) * halfFov, ny = ((y + 0.5) / SFM_VIEW_SIZE * 2 - 1) * halfFov, local = sfmNormalize3([nx, -ny, 1]), yaw = yawDeg * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw); return sfmNormalize3([local[0] * c + local[2] * s, local[1], -local[0] * s + local[2] * c]); }
function sfmCollectCorrespondences(leftFrame, rightFrame) { const corr = []; for (const leftView of leftFrame.views) { let best = null; for (const rightView of rightFrame.views) { const matches = sfmMatchViews(leftView.features, rightView.features); if (!best || matches.length > best.matches.length) best = { matches, rightView }; } if (!best || best.matches.length < 3) continue; for (const m of best.matches) corr.push({ leftBearing: sfmBearing(m.leftX, m.leftY, leftView.yaw), rightBearing: sfmBearing(m.rightX, m.rightY, best.rightView.yaw), quality: m.distance }); } return corr; }
async function sfmBuildFrame(time, maps) { const pano = await sfmCapturePanorama(time); return { time, views: maps.map((map, i) => ({ yaw: SFM_VIEW_YAWS[i], features: sfmDetect(sfmProject(pano, map)) })) }; }
function sfmPairSeed(a, b, n) { return (Math.floor(a * 1000) * 73856093 ^ Math.floor(b * 1000) * 19349663 ^ n * 83492791) >>> 0; }
function sfmEstimatePair(left, right) { const corr = sfmCollectCorrespondences(left, right), result = sfmEstimateRelative(corr, sfmPairSeed(left.time, right.time, corr.length)); return { start: left.time, end: right.time, gap: right.time - left.time, ...result }; }

function sfmSegmentFrameCount(segment, remainingBudget) {
  const duration = segment.end - segment.start;
  let desired = duration <= 4 ? Math.ceil(duration / 0.38) + 1 : duration <= 15 ? Math.ceil(duration / 0.65) + 1 : Math.ceil(duration / 1.2) + 1;
  desired = sfmClamp(desired, 5, 24);
  return Math.max(3, Math.min(desired, remainingBudget));
}
function sfmEvenTimes(start, end, count) { if (count <= 1 || end <= start) return [(start + end) / 2]; return Array.from({ length: count }, (_, i) => start + (end - start) * i / (count - 1)); }

function sfmBuildLocalGeometry(frames, pairs) {
  const cameraPoses = [{ position: [0, 0, 0], cameraToWorld: sfmIdentity3(), time: frames[0]?.time ?? 0 }];
  const points = [];
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i], prev = cameraPoses[cameraPoses.length - 1];
    if (!pair.success || !pair.rotation || !pair.translationDirection) {
      cameraPoses.push({ position: [...prev.position], cameraToWorld: [...prev.cameraToWorld], time: frames[i + 1]?.time ?? pair.end, valid: false });
      continue;
    }
    const stepWorld = sfmNormalize3(sfmMatVec3(prev.cameraToWorld, pair.translationDirection));
    const nextPosition = sfmAdd3(prev.position, stepWorld), nextCameraToWorld = sfmMul3(prev.cameraToWorld, sfmTranspose3(pair.rotation));
    const next = { position: nextPosition, cameraToWorld: nextCameraToWorld, time: frames[i + 1].time, valid: true };
    cameraPoses.push(next);
    for (const corr of pair.inlierCorrs.slice(0, 100)) {
      const d1 = sfmNormalize3(sfmMatVec3(prev.cameraToWorld, corr.leftBearing));
      const d2 = sfmNormalize3(sfmMatVec3(nextCameraToWorld, corr.rightBearing));
      const tri = sfmTriangulateRays(prev.position, d1, next.position, d2);
      if (!tri || tri.depth1 > 35 || tri.depth2 > 35) continue;
      points.push({ position: tri.point, error: tri.error, pairIndex: i });
      if (points.length >= SFM_MAX_POINTS) break;
    }
    if (points.length >= SFM_MAX_POINTS) break;
  }
  return { cameraPoses, points };
}

function sfmEvaluateSegment(segment, frames, pairs, skipPairs, geometry) {
  const solved = pairs.filter((p) => p.success), solveRatio = solved.length / Math.max(1, pairs.length), medianInlier = sfmMedian(solved.map((p) => p.inlierRatio)), medianParallax = sfmMedian(solved.map((p) => p.parallaxDeg));
  const skipSolved = skipPairs.filter((p) => p.success).length, skipRatio = skipSolved / Math.max(1, skipPairs.length), pointCount = geometry.points.length;
  const insane = solved.some((p) => p.parallaxDeg > SFM_MAX_PARALLAX_DEG);
  let quality = 'hold';
  if (!insane && solveRatio >= 0.60 && medianInlier >= 0.30 && medianParallax >= SFM_MIN_PARALLAX_DEG && medianParallax <= 25 && pointCount >= 24) quality = 'candidate';
  if (!insane && solveRatio >= 0.75 && medianInlier >= 0.40 && medianParallax >= SFM_GOOD_PARALLAX_DEG && medianParallax <= 20 && pointCount >= 45 && (skipPairs.length === 0 || skipRatio >= 0.45)) quality = 'good';
  return { segment, frames, pairs, skipPairs, geometry, solveRatio, medianInlier, medianParallax, skipRatio, pointCount, quality, insane };
}

function sfmEnsurePanel() {
  let panel = document.querySelector('#sfm-panel'); if (panel) return panel;
  const segmentPanel = document.querySelector('#segment-panel'); if (!segmentPanel) return null;
  panel = document.createElement('section'); panel.id = 'sfm-panel'; panel.className = 'sfm-panel'; panel.hidden = true;
  panel.innerHTML = `
    <div class="sfm-heading"><div><p class="eyebrow">局所SfM再計算</p><h3>3D化候補区間だけを細かく再構成</h3></div><span class="sfm-auto">自動設定</span></div>
    <p class="sfm-description">3D化候補区間の内部だけキーフレームを追加し、相対姿勢を再推定します。さらに1枚飛ばしの整合性も確認し、成立した対応から疎な3D点を三角測量します。大きすぎる視差角は姿勢破綻の可能性があるため除外します。</p>
    <div class="sfm-stats"><div><span>再計算した候補</span><strong id="sfm-count">—</strong></div><div><span>局所SfM良好</span><strong id="sfm-good">—</strong></div><div><span>追加キーフレーム</span><strong id="sfm-frames">—</strong></div><div><span>疎な3D点</span><strong id="sfm-points">—</strong></div></div>
    <div id="sfm-list" class="sfm-list"></div>
    <div id="sfm-message" class="message-box" hidden></div>
    <p class="sfm-note">この段階のカメラ間移動は依然として任意スケールです。疎点群は局所幾何の成立確認用で、Bundle Adjustment後の最終点群ではありません。</p>`;
  segmentPanel.insertAdjacentElement('afterend', panel); return panel;
}

function sfmDrawPreview(canvas, geometry) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), width = Math.max(300, canvas.clientWidth || 520), height = 220; canvas.width = width * dpr; canvas.height = height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); ctx.strokeStyle = '#d7dde7'; ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  const cameraPoints = geometry.cameraPoses.map((x) => x.position), cloud = geometry.points.map((x) => x.position); const all = [...cameraPoints, ...cloud];
  if (!all.length) return;
  let minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0])), minZ = Math.min(...all.map((p) => p[2])), maxZ = Math.max(...all.map((p) => p[2]));
  if (maxX - minX < 1e-4) { minX -= 1; maxX += 1; } if (maxZ - minZ < 1e-4) { minZ -= 1; maxZ += 1; }
  const pad = 20, scale = Math.min((width - 2 * pad) / (maxX - minX), (height - 2 * pad) / (maxZ - minZ)), xy = (p) => [pad + (p[0] - minX) * scale, height - pad - (p[2] - minZ) * scale];
  ctx.fillStyle = 'rgba(75,85,99,.28)'; for (const p of cloud) { const [x, y] = xy(p); ctx.fillRect(x - 1, y - 1, 2, 2); }
  if (cameraPoints.length > 1) { ctx.strokeStyle = '#111827'; ctx.lineWidth = 2; ctx.beginPath(); cameraPoints.forEach((p, i) => { const [x, y] = xy(p); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); }
  cameraPoints.forEach((p, i) => { const [x, y] = xy(p); ctx.beginPath(); ctx.arc(x, y, i === 0 || i === cameraPoints.length - 1 ? 4 : 2.5, 0, Math.PI * 2); ctx.fillStyle = i === 0 ? '#16803c' : i === cameraPoints.length - 1 ? '#b45309' : '#111827'; ctx.fill(); });
}

function sfmRenderResults(results, totalFrames) {
  const panel = sfmEnsurePanel(); if (!panel) return;
  panel.hidden = false; const good = results.filter((r) => r.quality === 'good'), usable = results.filter((r) => r.quality !== 'hold'), totalPoints = results.reduce((s, r) => s + r.pointCount, 0);
  panel.querySelector('#sfm-count').textContent = `${results.length}区間`; panel.querySelector('#sfm-good').textContent = good.length ? `${good.length}区間` : 'なし'; panel.querySelector('#sfm-frames').textContent = `${totalFrames}枚`; panel.querySelector('#sfm-points').textContent = totalPoints.toLocaleString();
  const list = panel.querySelector('#sfm-list'); list.replaceChildren();
  for (const result of results) {
    const card = document.createElement('article'); card.className = `sfm-card ${result.quality}`;
    const label = result.quality === 'good' ? '局所SfM良好' : result.quality === 'candidate' ? '再構成候補' : '保留';
    card.innerHTML = `<div class="sfm-card-head"><div><span>候補区間 ${result.segment.id}</span><h4>${result.segment.start.toFixed(1)}秒 〜 ${result.segment.end.toFixed(1)}秒</h4></div><span class="sfm-badge ${result.quality}">${label}</span></div><div class="sfm-metrics"><span>再解析フレーム <strong>${result.frames.length}枚</strong></span><span>姿勢成立率 <strong>${Math.round(result.solveRatio * 100)}%</strong></span><span>内点率中央値 <strong>${Math.round(result.medianInlier * 100)}%</strong></span><span>視差角中央値 <strong>${result.medianParallax.toFixed(2)}°</strong></span><span>1枚飛ばし整合 <strong>${Math.round(result.skipRatio * 100)}%</strong></span><span>疎3D点 <strong>${result.pointCount}点</strong></span></div><canvas class="sfm-preview"></canvas><p>${result.insane ? '極端に大きい視差角が含まれるため、姿勢破綻の可能性があり保留しました。' : result.quality === 'good' ? '区間内を細かく再計算しても姿勢と疎点群が比較的安定しています。' : result.quality === 'candidate' ? '局所的な3D復元は成立していますが、全体最適化前の候補として扱います。' : '追加フレーム後も姿勢または三角測量が十分に安定しませんでした。'}</p>`;
    list.append(card); sfmDrawPreview(card.querySelector('canvas'), result.geometry);
  }
  const message = panel.querySelector('#sfm-message'); message.hidden = false;
  if (good.length) { message.className = 'message-box success'; message.textContent = `${good.length}区間で、追加キーフレーム後も局所SfMが安定しました。次は複数フレームを同時に使うBundle Adjustmentと、同じ場所を再訪した場合のループ拘束を追加します。`; }
  else if (usable.length) { message.className = 'message-box warning'; message.textContent = '局所3D復元が成立する区間はありますが、まだ全体最適化前の候補です。次工程でカメラ姿勢と3D点を同時に調整します。'; }
  else { message.className = 'message-box warning'; message.textContent = '候補区間を細かく再解析しましたが、安定した局所SfMを確認できませんでした。別の区間または撮影条件の見直しが必要です。'; }
  window.__360gsLocalSfmResult = { results, good, usable, totalFrames, totalPoints }; window.dispatchEvent(new CustomEvent('360gs:sfm-ready', { detail: window.__360gsLocalSfmResult }));
}

async function sfmRun(detail) {
  if (sfmRunning || !sfmSourceVideo || !detail?.candidateSegments?.length) return;
  const signature = `${sfmSourceVideo.currentSrc || sfmSourceVideo.src}|${detail.candidateSegments.map((s) => `${s.start}-${s.end}-${s.quality}`).join('|')}`; if (signature === sfmLastSignature) return;
  sfmLastSignature = signature; sfmRunning = true; const generation = ++sfmGeneration; const panel = sfmEnsurePanel(); if (panel) panel.hidden = false;
  try {
    const saneCandidates = detail.candidateSegments.filter((s) => Number.isFinite(s.medianParallax) && s.medianParallax <= SFM_MAX_PARALLAX_DEG);
    const maps = sfmGetPerspectiveMaps(), results = []; let usedFrames = 0;
    for (let si = 0; si < saneCandidates.length && usedFrames < SFM_MAX_TOTAL_FRAMES; si += 1) {
      const segment = saneCandidates[si], count = sfmSegmentFrameCount(segment, SFM_MAX_TOTAL_FRAMES - usedFrames), times = sfmEvenTimes(segment.start, segment.end, count), frames = [];
      if (sfmProgressText) sfmProgressText.textContent = `候補区間 ${si + 1}/${saneCandidates.length} を細かく再解析しています`;
      for (let i = 0; i < times.length; i += 1) { if (generation !== sfmGeneration) return; frames.push(await sfmBuildFrame(times[i], maps)); usedFrames += 1; await new Promise((resolve) => setTimeout(resolve, 0)); }
      const pairs = []; for (let i = 0; i < frames.length - 1; i += 1) pairs.push(sfmEstimatePair(frames[i], frames[i + 1]));
      const skipPairs = []; for (let i = 0; i < frames.length - 2; i += 1) skipPairs.push(sfmEstimatePair(frames[i], frames[i + 2]));
      const geometry = sfmBuildLocalGeometry(frames, pairs), evaluation = sfmEvaluateSegment(segment, frames, pairs, skipPairs, geometry); results.push(evaluation);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (generation !== sfmGeneration) return; sfmRenderResults(results, usedFrames); if (sfmProgressText) sfmProgressText.textContent = '候補区間の局所SfM再計算まで完了しました';
  } catch (error) {
    const panelNow = sfmEnsurePanel(), message = panelNow?.querySelector('#sfm-message'); if (message) { message.hidden = false; message.className = 'message-box warning'; message.textContent = error?.message || '局所SfM再計算を完了できませんでした。'; } if (sfmProgressText) sfmProgressText.textContent = '局所SfM再計算を完了できませんでした';
  } finally { if (generation === sfmGeneration) sfmRunning = false; }
}

function sfmReset() { sfmGeneration += 1; sfmRunning = false; sfmLastSignature = ''; window.__360gsLocalSfmResult = null; const panel = document.querySelector('#sfm-panel'); if (panel) panel.hidden = true; }
window.addEventListener('360gs:segments-ready', (event) => window.setTimeout(() => sfmRun(event.detail), 120));
sfmSourceVideo?.addEventListener('loadedmetadata', sfmReset);
if (window.__360gsSegmentResult?.candidateSegments?.length) window.setTimeout(() => sfmRun(window.__360gsSegmentResult), 120);
