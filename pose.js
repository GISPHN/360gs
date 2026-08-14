const poseSourceVideo = document.querySelector('#source-video');
const poseFeatureMessage = document.querySelector('#feature-message');
const poseProgressText = document.querySelector('#progress-text');
const posePanel = document.querySelector('#pose-panel');
const poseFramesEl = document.querySelector('#pose-frames');
const posePairsEl = document.querySelector('#pose-pairs');
const poseSolvedEl = document.querySelector('#pose-solved');
const poseInlierEl = document.querySelector('#pose-inlier');
const poseParallaxEl = document.querySelector('#pose-parallax');
const poseTimeline = document.querySelector('#pose-timeline');
const poseMessage = document.querySelector('#pose-message');
const posePathCanvas = document.querySelector('#pose-path');
const posePathMeta = document.querySelector('#pose-path-meta');

let poseGeneration = 0;
let poseRunning = false;
let lastPoseSignature = '';
let posePerspectiveMaps = null;

const POSE_EQ_WIDTH = 640;
const POSE_EQ_HEIGHT = 320;
const POSE_VIEW_SIZE = 176;
const POSE_FOV_DEG = 100;
const POSE_VIEW_YAWS = [0, 90, 180, 270];
const POSE_MAX_FEATURES = 84;
const POSE_MIN_DISTANCE = 8;
const POSE_PATCH_OFFSETS = [-5, -2, 0, 2, 5];
const POSE_MIN_CORRESPONDENCES = 12;
const POSE_MAX_CORRESPONDENCES = 160;
const POSE_RANSAC_ITERS = 72;
const POSE_EPIPOLAR_THRESHOLD = 0.022;
const POSE_GOOD_INLIER_RATIO = 0.48;
const POSE_ATTENTION_INLIER_RATIO = 0.30;
const POSE_GOOD_PARALLAX_DEG = 0.45;
const POSE_MIN_PARALLAX_DEG = 0.16;

const poseWorkCanvas = document.createElement('canvas');

function poseMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function poseClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function poseNorm3(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

function poseNormalize3(v) {
  const n = poseNorm3(v);
  if (!Number.isFinite(n) || n < 1e-12) return [0, 0, 0];
  return [v[0] / n, v[1] / n, v[2] / n];
}

function poseDot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function poseCross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function poseScale3(v, s) {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function poseAdd3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function poseSub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function poseIdentity3() {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

function poseTranspose3(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

function poseMul3(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

function poseMatVec3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function poseDet3(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

function poseMatrixFromColumns(c0, c1, c2) {
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}

function poseGetColumn(m, column) {
  return [m[column], m[3 + column], m[6 + column]];
}

function poseJacobiEigenSymmetric(input, n, maxIterations = 180, tolerance = 1e-11) {
  const a = Array.from(input);
  const vectors = new Array(n * n).fill(0);
  for (let i = 0; i < n; i += 1) vectors[i * n + i] = 1;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let p = 0;
    let q = 1;
    let maxValue = 0;
    for (let r = 0; r < n; r += 1) {
      for (let c = r + 1; c < n; c += 1) {
        const value = Math.abs(a[r * n + c]);
        if (value > maxValue) {
          maxValue = value;
          p = r;
          q = c;
        }
      }
    }
    if (maxValue < tolerance) break;
    const app = a[p * n + p];
    const aqq = a[q * n + q];
    const apq = a[p * n + q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    for (let k = 0; k < n; k += 1) {
      if (k === p || k === q) continue;
      const akp = a[k * n + p];
      const akq = a[k * n + q];
      const newKp = c * akp - s * akq;
      const newKq = s * akp + c * akq;
      a[k * n + p] = newKp;
      a[p * n + k] = newKp;
      a[k * n + q] = newKq;
      a[q * n + k] = newKq;
    }
    a[p * n + p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q * n + q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p * n + q] = 0;
    a[q * n + p] = 0;
    for (let k = 0; k < n; k += 1) {
      const vkp = vectors[k * n + p];
      const vkq = vectors[k * n + q];
      vectors[k * n + p] = c * vkp - s * vkq;
      vectors[k * n + q] = s * vkp + c * vkq;
    }
  }
  const values = Array.from({ length: n }, (_, i) => a[i * n + i]);
  return { values, vectors };
}

function poseSvd3(matrix) {
  const mtm = poseMul3(poseTranspose3(matrix), matrix);
  const eigen = poseJacobiEigenSymmetric(mtm, 3, 80, 1e-12);
  const order = [0, 1, 2].sort((a, b) => eigen.values[b] - eigen.values[a]);
  const eigenColumn = (index) => [eigen.vectors[index], eigen.vectors[3 + index], eigen.vectors[6 + index]];
  let v0 = poseNormalize3(eigenColumn(order[0]));
  let v1 = eigenColumn(order[1]);
  v1 = poseNormalize3(poseSub3(v1, poseScale3(v0, poseDot3(v1, v0))));
  let v2 = poseNormalize3(poseCross3(v0, v1));
  if (poseNorm3(v0) < 0.5 || poseNorm3(v1) < 0.5 || poseNorm3(v2) < 0.5) return null;
  const s0 = Math.sqrt(Math.max(0, eigen.values[order[0]]));
  const s1 = Math.sqrt(Math.max(0, eigen.values[order[1]]));
  const s2 = Math.sqrt(Math.max(0, eigen.values[order[2]]));
  if (s0 < 1e-10 || s1 < 1e-10) return null;
  let u0 = poseNormalize3(poseScale3(poseMatVec3(matrix, v0), 1 / s0));
  let u1 = poseScale3(poseMatVec3(matrix, v1), 1 / s1);
  u1 = poseNormalize3(poseSub3(u1, poseScale3(u0, poseDot3(u1, u0))));
  let u2 = poseNormalize3(poseCross3(u0, u1));
  if (poseNorm3(u0) < 0.5 || poseNorm3(u1) < 0.5 || poseNorm3(u2) < 0.5) return null;
  const rawV2 = poseNormalize3(eigenColumn(order[2]));
  if (poseDot3(v2, rawV2) < 0) {
    v2 = poseScale3(v2, -1);
    u2 = poseScale3(u2, -1);
  }
  return { u: poseMatrixFromColumns(u0, u1, u2), v: poseMatrixFromColumns(v0, v1, v2), singular: [s0, s1, s2] };
}

function poseEnforceEssential(matrix) {
  const svd = poseSvd3(matrix);
  if (!svd) return null;
  const s = (svd.singular[0] + svd.singular[1]) / 2;
  return poseMul3(poseMul3(svd.u, [s, 0, 0, 0, s, 0, 0, 0, 0]), poseTranspose3(svd.v));
}

function poseFitEssential(correspondences) {
  if (correspondences.length < 8) return null;
  const ata = new Float64Array(81);
  for (const corr of correspondences) {
    const a = corr.leftBearing;
    const b = corr.rightBearing;
    const row = [b[0] * a[0], b[0] * a[1], b[0] * a[2], b[1] * a[0], b[1] * a[1], b[1] * a[2], b[2] * a[0], b[2] * a[1], b[2] * a[2]];
    for (let r = 0; r < 9; r += 1) for (let c = r; c < 9; c += 1) ata[r * 9 + c] += row[r] * row[c];
  }
  for (let r = 0; r < 9; r += 1) for (let c = 0; c < r; c += 1) ata[r * 9 + c] = ata[c * 9 + r];
  const eigen = poseJacobiEigenSymmetric(ata, 9, 220, 1e-10);
  let minIndex = 0;
  for (let i = 1; i < 9; i += 1) if (eigen.values[i] < eigen.values[minIndex]) minIndex = i;
  const raw = Array.from({ length: 9 }, (_, r) => eigen.vectors[r * 9 + minIndex]);
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm < 1e-12) return null;
  return poseEnforceEssential(raw.map((value) => value / norm));
}

function poseEpipolarResidual(essential, corr) {
  const ea = poseMatVec3(essential, corr.leftBearing);
  const etb = poseMatVec3(poseTranspose3(essential), corr.rightBearing);
  const numerator = Math.abs(poseDot3(corr.rightBearing, ea));
  return numerator / Math.max(1e-9, Math.sqrt(poseDot3(ea, ea) + poseDot3(etb, etb)));
}

function poseMakeRng(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) + 1) / 4294967297;
  };
}

function poseSampleEight(count, rng) {
  const chosen = new Set();
  while (chosen.size < 8 && chosen.size < count) chosen.add(Math.floor(rng() * count));
  return Array.from(chosen);
}

function poseRansacEssential(correspondences, seed) {
  if (correspondences.length < POSE_MIN_CORRESPONDENCES) return null;
  const usable = [...correspondences].sort((a, b) => a.quality - b.quality).slice(0, POSE_MAX_CORRESPONDENCES);
  const rng = poseMakeRng(seed);
  let best = null;
  for (let iteration = 0; iteration < POSE_RANSAC_ITERS; iteration += 1) {
    const indices = poseSampleEight(usable.length, rng);
    if (indices.length < 8) break;
    const essential = poseFitEssential(indices.map((index) => usable[index]));
    if (!essential) continue;
    const inliers = [];
    const residuals = [];
    let robustCost = 0;
    const thresholdSquared = POSE_EPIPOLAR_THRESHOLD * POSE_EPIPOLAR_THRESHOLD;
    for (const corr of usable) {
      const residual = poseEpipolarResidual(essential, corr);
      robustCost += Math.min(residual * residual, thresholdSquared);
      if (residual <= POSE_EPIPOLAR_THRESHOLD) {
        inliers.push(corr);
        residuals.push(residual);
      }
    }
    if (inliers.length < 8) continue;
    const medianResidual = poseMedian(residuals);
    if (!best || robustCost < best.robustCost || (Math.abs(robustCost - best.robustCost) < 1e-12 && inliers.length > best.inliers.length)) {
      best = { essential, inliers, medianResidual, robustCost };
    }
  }
  if (!best || best.inliers.length < 8) return null;
  const refined = poseFitEssential(best.inliers);
  if (!refined) return null;
  const finalInliers = [];
  const finalResiduals = [];
  for (const corr of usable) {
    const residual = poseEpipolarResidual(refined, corr);
    if (residual <= POSE_EPIPOLAR_THRESHOLD) {
      finalInliers.push(corr);
      finalResiduals.push(residual);
    }
  }
  if (finalInliers.length < 8) return null;
  return { essential: refined, inliers: finalInliers, total: usable.length, inlierRatio: finalInliers.length / Math.max(1, usable.length), medianResidual: poseMedian(finalResiduals) };
}

function poseDecomposeEssential(essential) {
  const svd = poseSvd3(essential);
  if (!svd) return [];
  let u = svd.u;
  let v = svd.v;
  if (poseDet3(u) < 0) u = poseMatrixFromColumns(poseGetColumn(u, 0), poseGetColumn(u, 1), poseScale3(poseGetColumn(u, 2), -1));
  if (poseDet3(v) < 0) v = poseMatrixFromColumns(poseGetColumn(v, 0), poseGetColumn(v, 1), poseScale3(poseGetColumn(v, 2), -1));
  const w = [0, -1, 0, 1, 0, 0, 0, 0, 1];
  const vt = poseTranspose3(v);
  let r1 = poseMul3(poseMul3(u, w), vt);
  let r2 = poseMul3(poseMul3(u, poseTranspose3(w)), vt);
  const t = poseNormalize3(poseGetColumn(u, 2));
  if (poseDet3(r1) < 0) r1 = r1.map((value) => -value);
  if (poseDet3(r2) < 0) r2 = r2.map((value) => -value);
  return [{ rotation: r1, translation: t }, { rotation: r1, translation: poseScale3(t, -1) }, { rotation: r2, translation: t }, { rotation: r2, translation: poseScale3(t, -1) }];
}

function poseCheiralityScore(candidate, correspondences) {
  const rt = poseTranspose3(candidate.rotation);
  const cameraCenter = poseScale3(poseMatVec3(rt, candidate.translation), -1);
  let positive = 0;
  let usable = 0;
  const rayErrors = [];
  for (const corr of correspondences.slice(0, 80)) {
    const d1 = corr.leftBearing;
    const d2 = poseNormalize3(poseMatVec3(rt, corr.rightBearing));
    const b = poseClamp(poseDot3(d1, d2), -0.999999, 0.999999);
    const denominator = 1 - b * b;
    if (denominator < 1e-6) continue;
    const e = poseDot3(d1, cameraCenter);
    const f = poseDot3(d2, cameraCenter);
    const lambda2 = (b * e - f) / denominator;
    const lambda1 = e + b * lambda2;
    usable += 1;
    const p1 = poseScale3(d1, lambda1);
    const p2 = poseAdd3(cameraCenter, poseScale3(d2, lambda2));
    rayErrors.push(poseNorm3(poseSub3(p1, p2)));
    if (lambda1 > 0 && lambda2 > 0) positive += 1;
  }
  return { positive, usable, ratio: positive / Math.max(1, usable), medianRayError: poseMedian(rayErrors), cameraCenter: poseNormalize3(cameraCenter) };
}

function poseRotationAngleDegrees(rotation) {
  return Math.acos(poseClamp((rotation[0] + rotation[4] + rotation[8] - 1) / 2, -1, 1)) * 180 / Math.PI;
}

function poseParallaxDegrees(rotation, correspondences) {
  const rt = poseTranspose3(rotation);
  return poseMedian(correspondences.map((corr) => {
    const secondInFirst = poseNormalize3(poseMatVec3(rt, corr.rightBearing));
    return Math.acos(poseClamp(poseDot3(corr.leftBearing, secondInFirst), -1, 1)) * 180 / Math.PI;
  }));
}

function poseEstimateRelative(correspondences, seed) {
  const model = poseRansacEssential(correspondences, seed);
  if (!model) return { success: false, state: 'weak', correspondences: correspondences.length, inliers: 0, inlierRatio: 0, parallaxDeg: 0, rotationDeg: 0 };
  const candidates = poseDecomposeEssential(model.essential);
  if (!candidates.length) return { success: false, state: 'weak', correspondences: correspondences.length, inliers: model.inliers.length, inlierRatio: model.inlierRatio, parallaxDeg: 0, rotationDeg: 0 };
  let best = null;
  for (const candidate of candidates) {
    const cheirality = poseCheiralityScore(candidate, model.inliers);
    if (!best || cheirality.positive > best.cheirality.positive || (cheirality.positive === best.cheirality.positive && cheirality.medianRayError < best.cheirality.medianRayError)) best = { candidate, cheirality };
  }
  const rotationDeg = poseRotationAngleDegrees(best.candidate.rotation);
  const parallaxDeg = poseParallaxDegrees(best.candidate.rotation, model.inliers);
  const cheiralityRatio = best.cheirality.ratio;
  let state = 'weak';
  if (model.inliers.length >= 12 && model.inlierRatio >= POSE_GOOD_INLIER_RATIO && cheiralityRatio >= 0.55 && parallaxDeg >= POSE_GOOD_PARALLAX_DEG) state = 'good';
  else if (model.inliers.length >= 9 && model.inlierRatio >= POSE_ATTENTION_INLIER_RATIO && cheiralityRatio >= 0.35 && parallaxDeg >= POSE_MIN_PARALLAX_DEG) state = 'attention';
  return { success: state !== 'weak', state, essential: model.essential, rotation: best.candidate.rotation, translationDirection: best.cheirality.cameraCenter, correspondences: model.total, inliers: model.inliers.length, inlierRatio: model.inlierRatio, cheiralityRatio, parallaxDeg, rotationDeg, medianResidual: model.medianResidual };
}

function poseGetPerspectiveMaps() {
  if (posePerspectiveMaps) return posePerspectiveMaps;
  const maps = [];
  const halfFov = Math.tan((POSE_FOV_DEG * Math.PI / 180) / 2);
  for (const yawDeg of POSE_VIEW_YAWS) {
    const yaw = yawDeg * Math.PI / 180;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const map = new Uint32Array(POSE_VIEW_SIZE * POSE_VIEW_SIZE);
    for (let y = 0; y < POSE_VIEW_SIZE; y += 1) {
      const ny = ((y + 0.5) / POSE_VIEW_SIZE * 2 - 1) * halfFov;
      for (let x = 0; x < POSE_VIEW_SIZE; x += 1) {
        const nx = ((x + 0.5) / POSE_VIEW_SIZE * 2 - 1) * halfFov;
        const length = Math.hypot(nx, -ny, 1);
        const vx = nx / length;
        const vy = -ny / length;
        const vz = 1 / length;
        const worldX = vx * cosYaw + vz * sinYaw;
        const worldZ = -vx * sinYaw + vz * cosYaw;
        const longitude = Math.atan2(worldX, worldZ);
        const latitude = Math.asin(poseClamp(vy, -1, 1));
        let sx = Math.floor((longitude / (2 * Math.PI) + 0.5) * POSE_EQ_WIDTH);
        sx = ((sx % POSE_EQ_WIDTH) + POSE_EQ_WIDTH) % POSE_EQ_WIDTH;
        const sy = poseClamp(Math.floor((0.5 - latitude / Math.PI) * POSE_EQ_HEIGHT), 0, POSE_EQ_HEIGHT - 1);
        map[y * POSE_VIEW_SIZE + x] = sy * POSE_EQ_WIDTH + sx;
      }
    }
    maps.push(map);
  }
  posePerspectiveMaps = maps;
  return maps;
}

async function poseSeekVideo(time) {
  if (!poseSourceVideo || !Number.isFinite(poseSourceVideo.duration)) throw new Error('動画を確認できません。');
  const bounded = poseClamp(time, 0, Math.max(0, poseSourceVideo.duration - 0.001));
  if (Math.abs(poseSourceVideo.currentTime - bounded) < 0.01) return;
  await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('撮影位置解析のための動画読み込みに時間がかかっています。')); }, 10000);
    const onSeek = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('動画のフレームを読み込めませんでした。')); };
    const cleanup = () => { window.clearTimeout(timer); poseSourceVideo.removeEventListener('seeked', onSeek); poseSourceVideo.removeEventListener('error', onError); };
    poseSourceVideo.addEventListener('seeked', onSeek, { once: true });
    poseSourceVideo.addEventListener('error', onError, { once: true });
    poseSourceVideo.currentTime = bounded;
  });
}

async function poseCapturePanorama(time) {
  await poseSeekVideo(time);
  poseWorkCanvas.width = POSE_EQ_WIDTH;
  poseWorkCanvas.height = POSE_EQ_HEIGHT;
  const context = poseWorkCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(poseSourceVideo, 0, 0, POSE_EQ_WIDTH, POSE_EQ_HEIGHT);
  const imageData = context.getImageData(0, 0, POSE_EQ_WIDTH, POSE_EQ_HEIGHT);
  const gray = new Uint8Array(POSE_EQ_WIDTH * POSE_EQ_HEIGHT);
  for (let i = 0, p = 0; i < imageData.data.length; i += 4, p += 1) gray[p] = Math.round(0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2]);
  return gray;
}

function poseProjectPerspective(gray, map) {
  const output = new Uint8Array(map.length);
  for (let i = 0; i < map.length; i += 1) output[i] = gray[map[i]];
  return output;
}

function poseCornerResponse(gray, size, x, y) {
  let a = 0, b = 0, c = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    const row = (y + dy) * size;
    for (let dx = -2; dx <= 2; dx += 1) {
      const px = x + dx;
      const gx = gray[row + px + 1] - gray[row + px - 1];
      const gy = gray[row + size + px] - gray[row - size + px];
      a += gx * gx; b += gy * gy; c += gx * gy;
    }
  }
  const trace = a + b;
  return (trace - Math.sqrt(Math.max(0, (a - b) * (a - b) + 4 * c * c))) / 2;
}

function posePatchDescriptor(gray, size, x, y) {
  const raw = new Float32Array(POSE_PATCH_OFFSETS.length * POSE_PATCH_OFFSETS.length);
  let mean = 0, index = 0;
  for (const dy of POSE_PATCH_OFFSETS) for (const dx of POSE_PATCH_OFFSETS) { const value = gray[(y + dy) * size + (x + dx)]; raw[index] = value; mean += value; index += 1; }
  mean /= raw.length;
  let variance = 0;
  for (let i = 0; i < raw.length; i += 1) { const d = raw[i] - mean; variance += d * d; }
  const std = Math.sqrt(variance / raw.length);
  if (std < 8) return null;
  for (let i = 0; i < raw.length; i += 1) raw[i] = (raw[i] - mean) / std;
  return raw;
}

function poseDetectFeatures(gray) {
  const size = POSE_VIEW_SIZE;
  const candidates = [];
  const margin = 8;
  for (let y = margin; y < size - margin; y += 3) for (let x = margin; x < size - margin; x += 3) { const response = poseCornerResponse(gray, size, x, y); if (response > 1700) candidates.push({ x, y, response }); }
  candidates.sort((a, b) => b.response - a.response);
  const features = [];
  for (const candidate of candidates) {
    if (features.some((existing) => { const dx = candidate.x - existing.x; const dy = candidate.y - existing.y; return dx * dx + dy * dy < POSE_MIN_DISTANCE * POSE_MIN_DISTANCE; })) continue;
    const descriptor = posePatchDescriptor(gray, size, candidate.x, candidate.y);
    if (!descriptor) continue;
    features.push({ ...candidate, descriptor });
    if (features.length >= POSE_MAX_FEATURES) break;
  }
  return features;
}

function poseDescriptorDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; sum += d * d; }
  return sum;
}

function poseNearestTwo(feature, targets) {
  let bestIndex = -1, best = Infinity, second = Infinity;
  for (let i = 0; i < targets.length; i += 1) { const distance = poseDescriptorDistance(feature.descriptor, targets[i].descriptor); if (distance < best) { second = best; best = distance; bestIndex = i; } else if (distance < second) second = distance; }
  return { bestIndex, best, second };
}

function poseMatchViews(leftFeatures, rightFeatures) {
  if (leftFeatures.length < 6 || rightFeatures.length < 6) return [];
  const forward = leftFeatures.map((feature) => poseNearestTwo(feature, rightFeatures));
  const reverse = rightFeatures.map((feature) => poseNearestTwo(feature, leftFeatures));
  const matches = [];
  forward.forEach((candidate, leftIndex) => {
    if (candidate.bestIndex < 0 || !Number.isFinite(candidate.second) || candidate.best > candidate.second * 0.78) return;
    const back = reverse[candidate.bestIndex];
    if (!back || back.bestIndex !== leftIndex || !Number.isFinite(back.second) || back.best > back.second * 0.82) return;
    const left = leftFeatures[leftIndex], right = rightFeatures[candidate.bestIndex];
    matches.push({ leftX: left.x, leftY: left.y, rightX: right.x, rightY: right.y, distance: candidate.best });
  });
  return matches;
}

function poseBearingFromViewPoint(x, y, yawDeg) {
  const halfFov = Math.tan((POSE_FOV_DEG * Math.PI / 180) / 2);
  const nx = ((x + 0.5) / POSE_VIEW_SIZE * 2 - 1) * halfFov;
  const ny = ((y + 0.5) / POSE_VIEW_SIZE * 2 - 1) * halfFov;
  const local = poseNormalize3([nx, -ny, 1]);
  const yaw = yawDeg * Math.PI / 180;
  const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
  return poseNormalize3([local[0] * cosYaw + local[2] * sinYaw, local[1], -local[0] * sinYaw + local[2] * cosYaw]);
}

function poseCollectCorrespondences(leftFrame, rightFrame) {
  const correspondences = [];
  for (const leftView of leftFrame.views) {
    let best = null;
    for (const rightView of rightFrame.views) { const matches = poseMatchViews(leftView.features, rightView.features); if (!best || matches.length > best.matches.length) best = { matches, rightView }; }
    if (!best || best.matches.length < 3) continue;
    for (const match of best.matches) correspondences.push({ leftBearing: poseBearingFromViewPoint(match.leftX, match.leftY, leftView.yaw), rightBearing: poseBearingFromViewPoint(match.rightX, match.rightY, best.rightView.yaw), quality: match.distance });
  }
  return correspondences;
}

async function poseBuildFrame(time, maps) {
  const panorama = await poseCapturePanorama(time);
  return { time, views: maps.map((map, index) => ({ yaw: POSE_VIEW_YAWS[index], features: poseDetectFeatures(poseProjectPerspective(panorama, map)) })) };
}

function posePlan(duration) {
  if (duration <= 60) return { initialCount: Math.max(8, Math.min(14, Math.ceil(duration / 3))), maxFrames: 30, minGap: 0.55 };
  if (duration <= 300) return { initialCount: Math.max(14, Math.min(24, Math.ceil(duration / 14))), maxFrames: 56, minGap: 1.4 };
  return { initialCount: Math.max(24, Math.min(40, Math.ceil(duration / 30))), maxFrames: 90, minGap: Math.max(3, duration / 190) };
}

function poseEvenTimes(duration, count) {
  const edge = Math.min(1, duration * 0.02), start = edge, end = Math.max(start, duration - edge);
  if (count <= 1 || end <= start) return [duration / 2];
  return Array.from({ length: count }, (_, index) => start + (end - start) * index / (count - 1));
}

function posePairSeed(leftTime, rightTime, count) {
  return (Math.floor(leftTime * 1000) * 73856093 ^ Math.floor(rightTime * 1000) * 19349663 ^ count * 83492791) >>> 0;
}

function poseEstimatePair(leftFrame, rightFrame) {
  const correspondences = poseCollectCorrespondences(leftFrame, rightFrame);
  return { start: leftFrame.time, end: rightFrame.time, gap: rightFrame.time - leftFrame.time, correspondences: correspondences.length, ...poseEstimateRelative(correspondences, posePairSeed(leftFrame.time, rightFrame.time, correspondences.length)) };
}

function poseChooseRefinement(pairs, minGap) {
  let best = null;
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    if (pair.gap <= minGap * 1.35 || pair.state === 'good') continue;
    const priority = (pair.state === 'weak' ? 3 : 1.4) * Math.sqrt(pair.gap / minGap) * (2 - (pair.inlierRatio || 0));
    if (!best || priority > best.priority) best = { index, pair, priority };
  }
  return best;
}

function poseBuildTrajectory(pairs) {
  const points = [[0, 0, 0]];
  let position = [0, 0, 0], cameraToWorld = poseIdentity3();
  for (const pair of pairs) {
    if (!pair.success || !pair.rotation || !pair.translationDirection) continue;
    position = poseAdd3(position, poseNormalize3(poseMatVec3(cameraToWorld, pair.translationDirection)));
    points.push([...position]);
    cameraToWorld = poseMul3(cameraToWorld, poseTranspose3(pair.rotation));
  }
  return points;
}

function poseDrawTrajectory(points) {
  if (!posePathCanvas) return;
  const canvas = posePathCanvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1), cssWidth = Math.max(320, canvas.clientWidth || 640), cssHeight = 260;
  canvas.width = Math.round(cssWidth * dpr); canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cssWidth, cssHeight);
  if (points.length < 2) { ctx.fillStyle = '#6b7280'; ctx.font = '14px sans-serif'; ctx.fillText('軌跡を描けるだけの相対姿勢がまだありません。', 20, 36); return; }
  const xs = points.map((p) => p[0]), zs = points.map((p) => p[2]);
  let minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
  if (maxX - minX < 1e-6) { minX -= 1; maxX += 1; } if (maxZ - minZ < 1e-6) { minZ -= 1; maxZ += 1; }
  const pad = 28, scale = Math.min((cssWidth - pad * 2) / (maxX - minX), (cssHeight - pad * 2) / (maxZ - minZ));
  const toCanvas = (p) => [pad + (p[0] - minX) * scale, cssHeight - pad - (p[2] - minZ) * scale];
  ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, cssWidth - 1, cssHeight - 1);
  ctx.strokeStyle = '#111827'; ctx.lineWidth = 2; ctx.beginPath();
  points.forEach((point, index) => { const [x, y] = toCanvas(point); if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
  points.forEach((point, index) => { const [x, y] = toCanvas(point); ctx.beginPath(); ctx.arc(x, y, index === 0 || index === points.length - 1 ? 5 : 3, 0, Math.PI * 2); ctx.fillStyle = index === 0 ? '#16803c' : (index === points.length - 1 ? '#b45309' : '#111827'); ctx.fill(); });
  ctx.fillStyle = '#4b5563'; ctx.font = '12px sans-serif'; const [sx, sy] = toCanvas(points[0]), [ex, ey] = toCanvas(points[points.length - 1]); ctx.fillText('開始', sx + 8, sy - 8); ctx.fillText('終了', ex + 8, ey - 8);
}

function poseRenderResult(frames, pairs, duration) {
  posePanel.hidden = false;
  poseFramesEl.textContent = `${frames.length}枚`;
  posePairsEl.textContent = `${pairs.length}組`;
  const solved = pairs.filter((pair) => pair.success);
  poseSolvedEl.textContent = solved.length ? `${solved.length}組` : 'なし';
  poseInlierEl.textContent = solved.length ? `${Math.round(poseMedian(solved.map((pair) => pair.inlierRatio)) * 100)}%` : '—';
  poseParallaxEl.textContent = solved.length ? `${poseMedian(solved.map((pair) => pair.parallaxDeg)).toFixed(2)}°` : '—';
  poseTimeline.replaceChildren();
  for (const pair of pairs) { const segment = document.createElement('div'); segment.className = `pose-segment ${pair.state}`; segment.style.flexGrow = String(Math.max(0.5, pair.gap)); segment.title = `${pair.start.toFixed(1)}〜${pair.end.toFixed(1)}秒：内点率 ${Math.round((pair.inlierRatio || 0) * 100)}% / 視差 ${Number(pair.parallaxDeg || 0).toFixed(2)}°`; poseTimeline.append(segment); }
  const trajectory = poseBuildTrajectory(pairs); poseDrawTrajectory(trajectory);
  posePathMeta.textContent = trajectory.length > 1 ? `相対姿勢 ${trajectory.length - 1} 区間を、各区間同じ長さとして描画しています。` : '相対姿勢が成立した区間が増えると、ここに移動方向の形状を表示します。';
  const weakCount = pairs.filter((pair) => pair.state === 'weak').length, solvedRatio = solved.length / Math.max(1, pairs.length), medianParallax = solved.length ? poseMedian(solved.map((pair) => pair.parallaxDeg)) : 0;
  poseMessage.hidden = false;
  if (solvedRatio >= 0.75 && weakCount <= Math.max(1, pairs.length * 0.15) && medianParallax >= POSE_GOOD_PARALLAX_DEG) { poseMessage.className = 'message-box success'; poseMessage.textContent = '外れ対応を除いた幾何学計算で、複数区間の相対回転と移動方向を推定できました。次はこれらを連結し、ループや再訪位置も使ってカメラ軌跡を安定化する工程へ進めます。'; }
  else if (solvedRatio >= 0.45) { poseMessage.className = 'message-box warning'; poseMessage.textContent = '相対姿勢を推定できる区間はありますが、一部は幾何学的な整合性または視差が不足しています。弱い区間は自動で細分化した上で、次工程では軌跡全体の整合性を確認します。'; }
  else { poseMessage.className = 'message-box warning'; poseMessage.textContent = '相対姿勢が安定して求まらない区間が多くあります。画像の重なり、移動速度、動く被写体、低テクスチャなどの影響が考えられます。次工程へ進む前に自動区間分割の対象として扱います。'; }
  const note = document.createElement('p'); note.className = 'pose-scale-note'; note.textContent = '重要：この段階で求まる移動は「方向」であり、メートル単位の距離スケールは未確定です。軌跡図も実距離ではありません。'; poseMessage.insertAdjacentElement('afterend', note);
  if (duration > 300) { const longNote = document.createElement('p'); longNote.className = 'pose-scale-note'; longNote.textContent = '長時間動画では、粗いキーフレームから開始し、姿勢推定が弱い区間だけ中間フレームを追加しています。'; note.insertAdjacentElement('afterend', longNote); }
}

async function poseRunAnalysis() {
  if (!posePanel || poseRunning || !poseSourceVideo || !Number.isFinite(poseSourceVideo.duration) || poseSourceVideo.duration < 5) return;
  const duration = poseSourceVideo.duration;
  const signature = `${poseSourceVideo.currentSrc || poseSourceVideo.src}|${duration.toFixed(3)}`;
  if (!signature || signature === lastPoseSignature) return;
  lastPoseSignature = signature; poseRunning = true; const generation = ++poseGeneration;
  posePanel.hidden = false; poseFramesEl.textContent = '準備中'; posePairsEl.textContent = '—'; poseSolvedEl.textContent = '確認中'; poseInlierEl.textContent = '—'; poseParallaxEl.textContent = '—'; poseTimeline.replaceChildren(); poseMessage.hidden = true; document.querySelectorAll('.pose-scale-note').forEach((element) => element.remove());
  try {
    const plan = posePlan(duration), maps = poseGetPerspectiveMaps(), times = poseEvenTimes(duration, plan.initialCount), frames = [];
    poseProgressText.textContent = '幾何学的な撮影位置を推定しています';
    for (let index = 0; index < times.length; index += 1) { if (generation !== poseGeneration) return; frames.push(await poseBuildFrame(times[index], maps)); poseFramesEl.textContent = `${frames.length}枚`; poseProgressText.textContent = `撮影位置用の特徴点を準備しています (${index + 1}/${times.length})`; await new Promise((resolve) => window.setTimeout(resolve, 0)); }
    let pairs = [];
    for (let index = 0; index < frames.length - 1; index += 1) { if (generation !== poseGeneration) return; pairs.push(poseEstimatePair(frames[index], frames[index + 1])); posePairsEl.textContent = `${pairs.length}組`; poseProgressText.textContent = `相対カメラ姿勢を計算しています (${index + 1}/${frames.length - 1})`; await new Promise((resolve) => window.setTimeout(resolve, 0)); }
    let additions = 0;
    while (frames.length < plan.maxFrames) { if (generation !== poseGeneration) return; const target = poseChooseRefinement(pairs, plan.minGap); if (!target) break; const midpoint = (target.pair.start + target.pair.end) / 2, midFrame = await poseBuildFrame(midpoint, maps); frames.splice(target.index + 1, 0, midFrame); pairs.splice(target.index, 1, poseEstimatePair(frames[target.index], frames[target.index + 1]), poseEstimatePair(frames[target.index + 1], frames[target.index + 2])); additions += 1; poseFramesEl.textContent = `${frames.length}枚`; posePairsEl.textContent = `${pairs.length}組`; poseProgressText.textContent = `弱い区間を詳しく確認しています（自動追加 ${additions}枚）`; await new Promise((resolve) => window.setTimeout(resolve, 0)); }
    if (generation !== poseGeneration) return;
    poseRenderResult(frames, pairs, duration); poseProgressText.textContent = '相対カメラ姿勢推定まで完了しました';
  } catch (error) {
    if (generation !== poseGeneration) return;
    posePanel.hidden = false; poseMessage.hidden = false; poseMessage.className = 'message-box warning'; poseMessage.textContent = error?.message || '相対カメラ姿勢を推定できませんでした。'; poseProgressText.textContent = '撮影位置推定を完了できませんでした';
  } finally { if (generation === poseGeneration) poseRunning = false; }
}

function poseMaybeStart() {
  if (!poseFeatureMessage || poseFeatureMessage.hidden || !poseFeatureMessage.textContent.trim()) return;
  window.setTimeout(() => poseRunAnalysis(), 80);
}

if (poseFeatureMessage && posePanel) {
  const observer = new MutationObserver(() => poseMaybeStart());
  observer.observe(poseFeatureMessage, { attributes: true, attributeFilter: ['hidden', 'class'], childList: true, characterData: true, subtree: true });
  poseSourceVideo?.addEventListener('loadedmetadata', () => { poseGeneration += 1; poseRunning = false; lastPoseSignature = ''; posePanel.hidden = true; poseTimeline.replaceChildren(); document.querySelectorAll('.pose-scale-note').forEach((element) => element.remove()); });
}
