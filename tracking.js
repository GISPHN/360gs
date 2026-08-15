import './tracking-ui.js';

const trSourceVideo = document.querySelector('#source-video');
const trProgressText = document.querySelector('#progress-text');

let trGeneration = 0;
let trRunning = false;
let trLastSignature = '';
const trMapCache = new Map();

const TR_VIEW_SIZE_LOW = 176;
const TR_VIEW_SIZE_STD = 256;
const TR_VIEW_SIZE_HIGH = 320;
const TR_FOV_DEG = 100;
const TR_VIEW_YAWS = [0, 90, 180, 270];
const TR_VIEW_DIRS = ['front', 'right', 'back', 'left'];
const TR_BASE_VIEW_SIZE = 176;
const TR_MAX_TRACKS = 420;
const TR_TARGET_TRACKS = 90;
const TR_MIN_TRACKS_FOR_BA = 25;
const TR_GOOD_TRACKS_FOR_BA = 50;
const TR_RESEED_MAX_PASSES = 2;
const TR_MIN_DIRECTION_RATIO = 0.12;
const TR_MAX_DIRECTION_RATIO = 0.55;
const TR_MIN_CONFIDENCE = 0.22;
const TR_MID_CONFIDENCE = 0.45;
const TR_HIGH_CONFIDENCE = 0.72;

const trCanvas = document.createElement('canvas');

function trClamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function trMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function trChooseViewSize(totalFrames) {
  const memory = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const hasWebGPU = !!navigator.gpu;
  if (totalFrames > 48) return TR_VIEW_SIZE_LOW;
  if (totalFrames > 24) return TR_VIEW_SIZE_STD;
  if (hasWebGPU && memory >= 8 && cores >= 8) return TR_VIEW_SIZE_HIGH;
  if (memory >= 4 && cores >= 4) return TR_VIEW_SIZE_STD;
  return TR_VIEW_SIZE_LOW;
}

function trPassConfig(pass, viewSize) {
  const scale = viewSize / TR_BASE_VIEW_SIZE;
  const baseMax = viewSize >= 300 ? 180 : viewSize >= 240 ? 150 : 115;
  return {
    maxFeatures: Math.min(220, baseMax + pass * 24),
    scanStep: pass === 0 ? 3 : 2,
    minResponse: pass === 0 ? 1250 : pass === 1 ? 800 : 520,
    minStd: pass === 0 ? 8 : pass === 1 ? 6 : 4.5,
    minDistance: Math.max(5, Math.round((pass === 0 ? 8 : pass === 1 ? 7 : 6) * scale)),
    ratio: pass === 0 ? 0.78 : pass === 1 ? 0.84 : 0.89,
    reverseRatio: pass === 0 ? 0.82 : pass === 1 ? 0.87 : 0.91,
    minMatchConfidence: pass === 0 ? 0.20 : pass === 1 ? 0.15 : 0.11,
    offsets: pass === 0 ? [1, 2] : [1, 2, 3],
  };
}

function trFeatureWeight(confidence) {
  if (confidence >= TR_HIGH_CONFIDENCE) return 1;
  if (confidence >= TR_MID_CONFIDENCE) return 0.55;
  if (confidence >= TR_MIN_CONFIDENCE) return 0.25;
  return 0;
}

async function trSeek(time) {
  if (!trSourceVideo || !Number.isFinite(trSourceVideo.duration)) throw new Error('動画を確認できません。');
  const bounded = trClamp(time, 0, Math.max(0, trSourceVideo.duration - 0.001));
  if (Math.abs(trSourceVideo.currentTime - bounded) < 0.008) return;
  await new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('特徴点追跡用フレームの読み込みに時間がかかっています。')); }, 10000);
    const ok = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('特徴点追跡用フレームを読み込めませんでした。')); };
    const cleanup = () => {
      clearTimeout(timer);
      trSourceVideo.removeEventListener('seeked', ok);
      trSourceVideo.removeEventListener('error', fail);
    };
    trSourceVideo.addEventListener('seeked', ok, { once: true });
    trSourceVideo.addEventListener('error', fail, { once: true });
    trSourceVideo.currentTime = bounded;
  });
}

function trMaps(viewSize) {
  if (trMapCache.has(viewSize)) return trMapCache.get(viewSize);
  const eqWidth = viewSize * 4;
  const eqHeight = viewSize * 2;
  const halfFov = Math.tan((TR_FOV_DEG * Math.PI / 180) / 2);
  const maps = [];
  for (const yawDeg of TR_VIEW_YAWS) {
    const yaw = yawDeg * Math.PI / 180;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const map = new Uint32Array(viewSize * viewSize);
    for (let y = 0; y < viewSize; y += 1) {
      for (let x = 0; x < viewSize; x += 1) {
        const nx = ((x + 0.5) / viewSize * 2 - 1) * halfFov;
        const ny = ((y + 0.5) / viewSize * 2 - 1) * halfFov;
        const len = Math.hypot(nx, -ny, 1);
        const vx = nx / len, vy = -ny / len, vz = 1 / len;
        const wx = vx * c + vz * s;
        const wz = -vx * s + vz * c;
        const longitude = Math.atan2(wx, wz);
        const latitude = Math.asin(trClamp(vy, -1, 1));
        let sx = Math.floor((longitude / (2 * Math.PI) + 0.5) * eqWidth);
        sx = ((sx % eqWidth) + eqWidth) % eqWidth;
        const sy = trClamp(Math.floor((0.5 - latitude / Math.PI) * eqHeight), 0, eqHeight - 1);
        map[y * viewSize + x] = sy * eqWidth + sx;
      }
    }
    maps.push(map);
  }
  const result = { viewSize, eqWidth, eqHeight, maps };
  trMapCache.set(viewSize, result);
  return result;
}

async function trCapturePanorama(time, eqWidth, eqHeight) {
  await trSeek(time);
  trCanvas.width = eqWidth;
  trCanvas.height = eqHeight;
  const ctx = trCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.drawImage(trSourceVideo, 0, 0, eqWidth, eqHeight);
  const rgba = ctx.getImageData(0, 0, eqWidth, eqHeight).data;
  const gray = new Uint8Array(eqWidth * eqHeight);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p += 1) gray[p] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
  return gray;
}

function trProject(gray, map) {
  const out = new Uint8Array(map.length);
  for (let i = 0; i < map.length; i += 1) out[i] = gray[map[i]];
  return out;
}

function trCorner(gray, size, x, y) {
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
  return (trace - Math.sqrt(Math.max(0, (a - b) ** 2 + 4 * c * c))) / 2;
}

function trDescriptor(gray, size, x, y, minStd) {
  const spacing = size >= 300 ? 8 : size >= 240 ? 6 : 5;
  const offsets = [-spacing, -Math.round(spacing / 2), 0, Math.round(spacing / 2), spacing];
  const raw = new Float32Array(25);
  let mean = 0, index = 0;
  for (const dy of offsets) for (const dx of offsets) {
    const value = gray[(y + dy) * size + x + dx];
    raw[index++] = value;
    mean += value;
  }
  mean /= raw.length;
  let variance = 0;
  for (const value of raw) variance += (value - mean) ** 2;
  const std = Math.sqrt(variance / raw.length);
  if (!Number.isFinite(std) || std < minStd) return null;
  for (let i = 0; i < raw.length; i += 1) raw[i] = (raw[i] - mean) / std;
  return { descriptor: raw, std };
}

function trDetect(gray, size, pass, dir) {
  const cfg = trPassConfig(pass, size);
  const margin = size >= 300 ? 12 : 10;
  const candidates = [];
  for (let y = margin; y < size - margin; y += cfg.scanStep) {
    for (let x = margin; x < size - margin; x += cfg.scanStep) {
      const response = trCorner(gray, size, x, y);
      if (response >= cfg.minResponse) candidates.push({ x, y, response });
    }
  }
  candidates.sort((a, b) => b.response - a.response);
  const features = [];
  for (const candidate of candidates) {
    if (features.some((f) => (candidate.x - f.rawX) ** 2 + (candidate.y - f.rawY) ** 2 < cfg.minDistance ** 2)) continue;
    const desc = trDescriptor(gray, size, candidate.x, candidate.y, cfg.minStd);
    if (!desc) continue;
    const cornerScore = trClamp(candidate.response / (candidate.response + 2400), 0, 1);
    const contrastScore = trClamp((desc.std - 4) / 30, 0, 1);
    const baseConfidence = 0.58 * cornerScore + 0.42 * contrastScore;
    features.push({
      x: candidate.x * TR_BASE_VIEW_SIZE / size,
      y: candidate.y * TR_BASE_VIEW_SIZE / size,
      rawX: candidate.x,
      rawY: candidate.y,
      response: candidate.response,
      descriptor: desc.descriptor,
      cornerScore,
      contrastScore,
      baseConfidence,
      trackingConfidence: baseConfidence,
      dir,
    });
    if (features.length >= cfg.maxFeatures) break;
  }
  return features;
}

function trDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function trNearestTwo(source, targets) {
  let bestIndex = -1, best = Infinity, second = Infinity;
  for (let i = 0; i < targets.length; i += 1) {
    const distance = trDistance(source.descriptor, targets[i].descriptor);
    if (distance < best) { second = best; best = distance; bestIndex = i; }
    else if (distance < second) second = distance;
  }
  return { bestIndex, best, second };
}

function trFlatten(frame, frameIndex) {
  const out = [];
  frame.views.forEach((view, viewIndex) => {
    view.features.forEach((feature, featureIndex) => {
      out.push({ ...feature, frameIndex, viewIndex, featureIndex, key: `${frameIndex}:${viewIndex}:${featureIndex}`, yaw: view.yaw });
    });
  });
  return out;
}

function trMatch(left, right, pass) {
  if (left.length < 8 || right.length < 8) return [];
  const cfg = trPassConfig(pass, TR_BASE_VIEW_SIZE);
  const forward = left.map((feature) => trNearestTwo(feature, right));
  const reverse = right.map((feature) => trNearestTwo(feature, left));
  const matches = [];
  forward.forEach((m, li) => {
    if (m.bestIndex < 0 || !Number.isFinite(m.second) || m.second <= 1e-9 || m.best > m.second * cfg.ratio) return;
    const back = reverse[m.bestIndex];
    if (!back || back.bestIndex !== li || !Number.isFinite(back.second) || back.second <= 1e-9 || back.best > back.second * cfg.reverseRatio) return;
    const ratioScore = trClamp(1 - m.best / Math.max(1e-9, m.second), 0, 1);
    const featureScore = (left[li].baseConfidence + right[m.bestIndex].baseConfidence) / 2;
    const confidence = 0.52 * featureScore + 0.48 * ratioScore;
    if (confidence < cfg.minMatchConfidence) return;
    matches.push({ left: left[li], right: right[m.bestIndex], confidence, distance: m.best });
  });
  return matches;
}

class TRUnionFind {
  constructor() { this.parent = new Map(); }
  add(key) { if (!this.parent.has(key)) this.parent.set(key, key); }
  find(key) {
    const parent = this.parent.get(key);
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }
  union(a, b) {
    this.add(a); this.add(b);
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function trBuildTracks(frames, pass) {
  const flattened = frames.map(trFlatten);
  const lookup = new Map();
  const uf = new TRUnionFind();
  flattened.flat().forEach((obs) => { lookup.set(obs.key, obs); uf.add(obs.key); });
  const cfg = trPassConfig(pass, TR_BASE_VIEW_SIZE);
  for (const offset of cfg.offsets) {
    for (let i = 0; i + offset < flattened.length; i += 1) {
      const matches = trMatch(flattened[i], flattened[i + offset], pass);
      for (const match of matches) {
        match.left.trackingConfidence = Math.max(match.left.trackingConfidence || 0, match.confidence);
        match.right.trackingConfidence = Math.max(match.right.trackingConfidence || 0, match.confidence);
        uf.union(match.left.key, match.right.key);
      }
    }
  }
  const groups = new Map();
  for (const obs of lookup.values()) {
    const root = uf.find(obs.key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(obs);
  }
  const tracks = [];
  for (const observations of groups.values()) {
    const byFrame = new Map();
    for (const obs of observations) {
      const confidence = Math.max(obs.baseConfidence || 0, obs.trackingConfidence || 0);
      const existing = byFrame.get(obs.frameIndex);
      if (!existing || confidence > existing.confidence) byFrame.set(obs.frameIndex, { ...obs, confidence });
    }
    const unique = [...byFrame.values()].sort((a, b) => a.frameIndex - b.frameIndex);
    if (unique.length < 3) continue;
    const meanConfidence = unique.reduce((s, obs) => s + obs.confidence, 0) / unique.length;
    const weight = trFeatureWeight(meanConfidence);
    if (!weight) continue;
    const temporalSpan = unique[unique.length - 1].frameIndex - unique[0].frameIndex;
    const score = unique.length * 100 + temporalSpan * 8 + meanConfidence * 40;
    tracks.push({ observations: unique, meanConfidence, weight, score });
  }
  tracks.sort((a, b) => b.score - a.score);
  return tracks.slice(0, TR_MAX_TRACKS);
}

function trDirectionBalance(tracks) {
  const counts = { front: 0, right: 0, back: 0, left: 0 };
  for (const track of tracks) for (const obs of track.observations) counts[obs.dir] = (counts[obs.dir] || 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const ratios = {};
  for (const dir of TR_VIEW_DIRS) ratios[dir] = total ? counts[dir] / total : 0;
  const ok = total > 0 && Object.values(ratios).every((ratio) => ratio >= TR_MIN_DIRECTION_RATIO && ratio <= TR_MAX_DIRECTION_RATIO);
  return { counts, ratios, total, ok };
}

function trSummary(tracks, pass, viewSize) {
  const observations = tracks.reduce((sum, track) => sum + track.observations.length, 0);
  let high = 0, mid = 0, low = 0;
  for (const track of tracks) {
    if (track.meanConfidence >= TR_HIGH_CONFIDENCE) high += 1;
    else if (track.meanConfidence >= TR_MID_CONFIDENCE) mid += 1;
    else low += 1;
  }
  const directionalBalance = trDirectionBalance(tracks);
  let judge = 'hold';
  if (tracks.length >= TR_GOOD_TRACKS_FOR_BA && observations >= 180 && directionalBalance.ok) judge = 'good';
  else if (tracks.length >= TR_MIN_TRACKS_FOR_BA && observations >= 100) judge = 'candidate';
  else if (tracks.length >= 12) judge = 'reseed';
  return { trackCount: tracks.length, observationCount: observations, high, mid, low, directionalBalance, pass, viewSize, judge };
}

function trNeedReseed(summary) {
  return summary.trackCount < TR_MIN_TRACKS_FOR_BA || summary.observationCount < 120 || !summary.directionalBalance.ok;
}

function trStateScore(summary) {
  return summary.trackCount * 6 + summary.observationCount * 0.35 + summary.high * 3 + (summary.directionalBalance.ok ? 40 : 0);
}

function trFilterFramesToTracks(frames, tracks) {
  const keys = new Set();
  for (const track of tracks) for (const obs of track.observations) keys.add(obs.key);
  return frames.map((frame, frameIndex) => ({
    time: frame.time,
    views: frame.views.map((view, viewIndex) => ({
      yaw: view.yaw,
      features: view.features
        .filter((feature, featureIndex) => keys.has(`${frameIndex}:${viewIndex}:${featureIndex}`))
        .map((feature) => ({
          x: feature.x,
          y: feature.y,
          descriptor: feature.descriptor,
          response: Math.round(1000 + 9000 * Math.max(feature.baseConfidence || 0, feature.trackingConfidence || 0)),
          trackingConfidence: Math.max(feature.baseConfidence || 0, feature.trackingConfidence || 0),
          dir: feature.dir,
        })),
    })),
  }));
}

async function trBuildDenseFrames(source, viewSize, pass, generation) {
  const mapInfo = trMaps(viewSize);
  const frames = [];
  for (let frameIndex = 0; frameIndex < source.frames.length; frameIndex += 1) {
    if (generation !== trGeneration) return null;
    const time = source.frames[frameIndex].time;
    const pano = await trCapturePanorama(time, mapInfo.eqWidth, mapInfo.eqHeight);
    const views = mapInfo.maps.map((map, viewIndex) => {
      const gray = trProject(pano, map);
      return { yaw: TR_VIEW_YAWS[viewIndex], dir: TR_VIEW_DIRS[viewIndex], features: trDetect(gray, viewSize, pass, TR_VIEW_DIRS[viewIndex]) };
    });
    frames.push({ time, views });
    if (trProgressText) trProgressText.textContent = `特徴点追跡を安定化しています（${frameIndex + 1}/${source.frames.length}）`;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return frames;
}

async function trProcessSource(source, viewSize, generation) {
  let best = null;
  for (let pass = 0; pass <= TR_RESEED_MAX_PASSES; pass += 1) {
    const frames = await trBuildDenseFrames(source, viewSize, pass, generation);
    if (!frames) return null;
    const tracks = trBuildTracks(frames, pass);
    const summary = trSummary(tracks, pass, viewSize);
    const state = { frames, tracks, summary, score: trStateScore(summary) };
    if (!best || state.score > best.score) best = state;
    if (!trNeedReseed(summary) || tracks.length >= TR_TARGET_TRACKS) break;
  }
  if (!best) return null;
  const selectedTracks = best.tracks.filter((track) => track.weight > 0).slice(0, TR_MAX_TRACKS);
  const filteredFrames = trFilterFramesToTracks(best.frames, selectedTracks);
  const finalSummary = trSummary(selectedTracks, best.summary.pass, viewSize);
  finalSummary.reseedPasses = best.summary.pass;
  finalSummary.selectedFeatureCount = filteredFrames.reduce((sum, frame) => sum + frame.views.reduce((s, view) => s + view.features.length, 0), 0);
  return { frames: filteredFrames, tracks: selectedTracks, summary: finalSummary };
}

async function trRun(detail) {
  if (trRunning || !detail?.usable?.length || !trSourceVideo) return;
  const signature = `${trSourceVideo.currentSrc || trSourceVideo.src}|${detail.usable.map((item) => `${item.segment.id}-${item.frames.length}-${item.pointCount}`).join('|')}`;
  if (signature === trLastSignature) return;
  trLastSignature = signature;
  trRunning = true;
  const generation = ++trGeneration;
  try {
    const totalFrames = detail.usable.reduce((sum, item) => sum + item.frames.length, 0);
    const viewSize = trChooseViewSize(totalFrames);
    const enhancedUsable = [];
    const trackingResults = [];
    for (let i = 0; i < detail.usable.length; i += 1) {
      if (generation !== trGeneration) return;
      const source = detail.usable[i];
      if (trProgressText) trProgressText.textContent = `候補区間 ${i + 1}/${detail.usable.length} の特徴点追跡を安定化しています`;
      const tracking = await trProcessSource(source, viewSize, generation);
      if (!tracking) continue;
      const enhanced = { ...source, frames: tracking.frames, tracking: tracking.summary };
      enhancedUsable.push(enhanced);
      trackingResults.push({ segment: source.segment, ...tracking.summary });
    }
    if (generation !== trGeneration) return;
    const good = trackingResults.filter((result) => result.judge === 'good');
    const candidates = trackingResults.filter((result) => result.judge === 'candidate');
    const trackCount = trackingResults.reduce((sum, result) => sum + result.trackCount, 0);
    const observationCount = trackingResults.reduce((sum, result) => sum + result.observationCount, 0);
    const summaryDetail = { results: trackingResults, good, candidates, trackCount, observationCount, viewSize };
    window.__360gsTrackingResult = summaryDetail;
    window.dispatchEvent(new CustomEvent('360gs:tracking-summary', { detail: summaryDetail }));
    const enhancedDetail = { ...detail, usable: enhancedUsable, trackingStable: true, trackingSummary: summaryDetail };
    window.__360gsTrackedSfmResult = enhancedDetail;
    if (trProgressText) trProgressText.textContent = '特徴点追跡を安定化し、全体最適化へ進みます';
    window.dispatchEvent(new CustomEvent('360gs:sfm-ready', { detail: enhancedDetail }));
  } catch (error) {
    const summaryDetail = { results: [], good: [], candidates: [], trackCount: 0, observationCount: 0, error: error?.message || '特徴点追跡を完了できませんでした。' };
    window.__360gsTrackingResult = summaryDetail;
    window.dispatchEvent(new CustomEvent('360gs:tracking-summary', { detail: summaryDetail }));
    if (trProgressText) trProgressText.textContent = '特徴点追跡を完了できませんでした';
    const fallback = { ...detail, trackingStable: true, trackingSummary: summaryDetail };
    window.dispatchEvent(new CustomEvent('360gs:sfm-ready', { detail: fallback }));
  } finally {
    if (generation === trGeneration) trRunning = false;
  }
}

function trReset() {
  trGeneration += 1;
  trRunning = false;
  trLastSignature = '';
  window.__360gsTrackingResult = null;
  window.__360gsTrackedSfmResult = null;
}

window.addEventListener('360gs:sfm-ready', (event) => {
  if (event.detail?.trackingStable) return;
  event.stopImmediatePropagation();
  window.setTimeout(() => trRun(event.detail), 80);
});

trSourceVideo?.addEventListener('loadedmetadata', trReset);
