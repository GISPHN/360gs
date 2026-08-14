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
const continuityPanel = document.querySelector('#continuity-panel');
const continuityMode = document.querySelector('#continuity-mode');
const continuityCount = document.querySelector('#continuity-count');
const continuityAdded = document.querySelector('#continuity-added');
const continuityWeak = document.querySelector('#continuity-weak');
const continuityTimeline = document.querySelector('#continuity-timeline');
const continuityMessage = document.querySelector('#continuity-message');
const featurePanel = document.querySelector('#feature-panel');
const featureFrames = document.querySelector('#feature-frames');
const featurePairs = document.querySelector('#feature-pairs');
const featureWeak = document.querySelector('#feature-weak');
const featureParallax = document.querySelector('#feature-parallax');
const featureTimeline = document.querySelector('#feature-timeline');
const featureMessage = document.querySelector('#feature-message');

let currentUrl = null;
let frameUrls = [];
let analysisGeneration = 0;
let perspectiveMapCache = null;

const MAX_PREVIEW_FRAMES = 12;
const PREVIEW_WIDTH = 960;
const ANALYSIS_WIDTH = 256;
const ANALYSIS_HEIGHT = 128;
const BAND_TOP = 0.22;
const BAND_BOTTOM = 0.78;
const CONTINUITY_TARGET = 0.58;
const CONTINUITY_GOOD = 0.72;
const CONTINUITY_WEAK = 0.46;

const FEATURE_EQ_WIDTH = 512;
const FEATURE_EQ_HEIGHT = 256;
const FEATURE_VIEW_SIZE = 144;
const FEATURE_FOV_DEG = 100;
const FEATURE_VIEW_YAWS = [0, 90, 180, 270];
const FEATURE_MAX_POINTS = 64;
const FEATURE_PATCH_OFFSETS = [-5, -2, 0, 2, 5];
const FEATURE_MIN_DISTANCE = 8;
const FEATURE_GOOD_MATCHES = 34;
const FEATURE_WEAK_MATCHES = 14;
const PARALLAX_PROXY_THRESHOLD = 1.6;

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

function clearContinuity() {
  continuityPanel.hidden = true;
  continuityTimeline.replaceChildren();
  continuityMessage.hidden = true;
  continuityMessage.textContent = '';
  continuityMessage.className = 'message-box';
  continuityMode.textContent = '—';
  continuityCount.textContent = '—';
  continuityAdded.textContent = '—';
  continuityWeak.textContent = '—';
  document.querySelectorAll('.continuity-long-note').forEach((element) => element.remove());
}

function clearFeatureAnalysis() {
  featurePanel.hidden = true;
  featureTimeline.replaceChildren();
  featureMessage.hidden = true;
  featureMessage.textContent = '';
  featureMessage.className = 'message-box';
  featureFrames.textContent = '—';
  featurePairs.textContent = '—';
  featureWeak.textContent = '—';
  featureParallax.textContent = '—';
  document.querySelectorAll('.feature-long-note').forEach((element) => element.remove());
}

function cleanup() {
  analysisGeneration += 1;
  clearFrames();
  clearContinuity();
  clearFeatureAnalysis();
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
  const bounded = Math.max(0, Math.min(video.duration || time, time));
  if (Math.abs(video.currentTime - bounded) < 0.01) return;
  const promise = waitForEvent(video, 'seeked', 10000);
  video.currentTime = bounded;
  await promise;
}

function choosePreviewTimes(duration) {
  const count = Math.max(4, Math.min(MAX_PREVIEW_FRAMES, Math.ceil(duration / 4)));
  const start = duration * 0.03;
  const end = duration * 0.97;
  if (count === 1 || end <= start) return [Math.max(0, duration / 2)];
  return Array.from({ length: count }, (_, index) => start + (end - start) * (index / (count - 1)));
}

async function capturePreviewFrame(time, index, total) {
  await seekVideo(time);

  const ratio = video.videoWidth / video.videoHeight;
  const width = Math.min(PREVIEW_WIDTH, video.videoWidth);
  const height = Math.round(width / ratio);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
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

  const percent = 18 + ((index + 1) / total) * 20;
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

function createAnalysisPlan(duration) {
  if (duration <= 60) {
    const initialCount = Math.max(8, Math.min(14, Math.ceil(duration / 5)));
    const budget = Math.max(initialCount + 4, Math.min(36, Math.ceil(duration / 1.5)));
    return {
      mode: '短時間モード',
      initialCount,
      budget,
      minGap: 0.75,
    };
  }

  if (duration <= 300) {
    const initialCount = Math.max(16, Math.min(28, Math.ceil(duration / 12)));
    const budget = Math.max(initialCount + 8, Math.min(90, Math.ceil(duration / 3)));
    return {
      mode: '標準モード',
      initialCount,
      budget,
      minGap: Math.max(1.5, duration / budget),
    };
  }

  const initialCount = Math.max(28, Math.min(42, Math.ceil(duration / 24)));
  const budget = Math.max(initialCount + 12, Math.min(180, Math.ceil(duration / 5)));
  return {
    mode: '長時間モード',
    initialCount,
    budget,
    minGap: Math.max(3, duration / budget),
  };
}

function evenlySpacedTimes(duration, count) {
  const start = Math.min(duration * 0.02, 1.0);
  const end = Math.max(start, duration - Math.min(duration * 0.02, 1.0));
  if (count <= 1 || end <= start) return [duration / 2];
  return Array.from({ length: count }, (_, index) => start + (end - start) * (index / (count - 1)));
}

function normalizeArray(values) {
  let mean = 0;
  for (let i = 0; i < values.length; i += 1) mean += values[i];
  mean /= Math.max(1, values.length);

  let variance = 0;
  for (let i = 0; i < values.length; i += 1) {
    const delta = values[i] - mean;
    variance += delta * delta;
  }
  const std = Math.sqrt(variance / Math.max(1, values.length)) || 1;

  const output = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) output[i] = (values[i] - mean) / std;
  return output;
}

function buildDescriptor(imageData, width, height) {
  const y0 = Math.floor(height * BAND_TOP);
  const y1 = Math.max(y0 + 1, Math.floor(height * BAND_BOTTOM));
  const bandHeight = y1 - y0;
  const raw = new Float32Array(width * bandHeight);
  const signatureRaw = new Float32Array(width);

  for (let y = 0; y < bandHeight; y += 1) {
    const sourceY = y + y0;
    for (let x = 0; x < width; x += 1) {
      const sourceIndex = (sourceY * width + x) * 4;
      const r = imageData.data[sourceIndex];
      const g = imageData.data[sourceIndex + 1];
      const b = imageData.data[sourceIndex + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      raw[y * width + x] = luminance;
      signatureRaw[x] += luminance;
    }
  }

  for (let x = 0; x < width; x += 1) signatureRaw[x] /= bandHeight;

  return {
    width,
    height: bandHeight,
    pixels: normalizeArray(raw),
    signature: normalizeArray(signatureRaw),
  };
}

async function captureAnalysisDescriptor(time) {
  await seekVideo(time);
  canvas.width = ANALYSIS_WIDTH;
  canvas.height = ANALYSIS_HEIGHT;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const imageData = context.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  return buildDescriptor(imageData, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
}

function signatureCorrelation(a, b, shift) {
  const width = a.length;
  let sum = 0;
  for (let x = 0; x < width; x += 1) {
    const bx = (x + shift + width) % width;
    sum += a[x] * b[bx];
  }
  return sum / width;
}

function findBestHorizontalShift(a, b) {
  const width = a.length;
  let bestShift = 0;
  let bestScore = -Infinity;

  for (let shift = 0; shift < width; shift += 4) {
    const score = signatureCorrelation(a, b, shift);
    if (score > bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }

  const center = bestShift;
  for (let delta = -4; delta <= 4; delta += 1) {
    const shift = (center + delta + width) % width;
    const score = signatureCorrelation(a, b, shift);
    if (score > bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }

  return bestShift;
}

function pixelCorrelation(a, b, horizontalShift, verticalShift) {
  const width = a.width;
  const height = a.height;
  let sum = 0;
  let count = 0;

  for (let y = 4; y < height - 4; y += 2) {
    const by = y + verticalShift;
    if (by < 0 || by >= height) continue;
    for (let x = 0; x < width; x += 2) {
      const bx = (x + horizontalShift + width) % width;
      sum += a.pixels[y * width + x] * b.pixels[by * width + bx];
      count += 1;
    }
  }

  return count ? sum / count : -1;
}

function compareDescriptors(a, b) {
  const shift = findBestHorizontalShift(a.signature, b.signature);
  let best = -1;
  for (const verticalShift of [-4, -2, 0, 2, 4]) {
    best = Math.max(best, pixelCorrelation(a, b, shift, verticalShift));
  }
  return Math.max(-1, Math.min(1, best));
}

function classifyContinuity(score) {
  if (score >= CONTINUITY_GOOD) return 'good';
  if (score < CONTINUITY_WEAK) return 'weak';
  return 'attention';
}

function pairScore(left, right, cache) {
  const key = `${left.time.toFixed(6)}|${right.time.toFixed(6)}`;
  if (cache.has(key)) return cache.get(key);
  const score = compareDescriptors(left.descriptor, right.descriptor);
  cache.set(key, score);
  return score;
}

function findWorstSplittableGap(samples, minGap, scoreCache) {
  let candidate = null;

  for (let index = 0; index < samples.length - 1; index += 1) {
    const left = samples[index];
    const right = samples[index + 1];
    const gap = right.time - left.time;
    if (gap <= minGap * 1.35) continue;

    const score = pairScore(left, right, scoreCache);
    if (score >= CONTINUITY_TARGET) continue;

    const urgency = (CONTINUITY_TARGET - score) * Math.sqrt(gap / minGap);
    if (!candidate || urgency > candidate.urgency) {
      candidate = { index, left, right, gap, score, urgency };
    }
  }

  return candidate;
}

async function runAdaptiveContinuity(duration, generation) {
  clearContinuity();
  continuityPanel.hidden = false;

  const plan = createAnalysisPlan(duration);
  continuityMode.textContent = plan.mode;
  continuityCount.textContent = '準備中';
  continuityAdded.textContent = '0';
  continuityWeak.textContent = '確認中';
  setProgress(40, `${plan.mode}で映像のつながりを確認しています`);

  const initialTimes = evenlySpacedTimes(duration, plan.initialCount);
  const samples = [];
  const scoreCache = new Map();

  for (let index = 0; index < initialTimes.length; index += 1) {
    if (generation !== analysisGeneration) return null;
    const descriptor = await captureAnalysisDescriptor(initialTimes[index]);
    samples.push({ time: initialTimes[index], descriptor });
    const percent = 40 + ((index + 1) / initialTimes.length) * 14;
    setProgress(percent, `動画全体を確認しています (${index + 1}/${initialTimes.length})`);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  samples.sort((a, b) => a.time - b.time);
  const initialCount = samples.length;
  let additions = 0;

  while (samples.length < plan.budget) {
    if (generation !== analysisGeneration) return null;
    const candidate = findWorstSplittableGap(samples, plan.minGap, scoreCache);
    if (!candidate) break;

    const midpoint = (candidate.left.time + candidate.right.time) / 2;
    const descriptor = await captureAnalysisDescriptor(midpoint);
    samples.splice(candidate.index + 1, 0, { time: midpoint, descriptor });
    additions += 1;

    const fill = Math.min(1, additions / Math.max(1, plan.budget - initialCount));
    setProgress(54 + fill * 10, `必要な区間を詳しく確認しています (${samples.length}枚)`);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  const pairs = [];
  let goodCount = 0;
  let attentionCount = 0;
  let weakCount = 0;

  for (let index = 0; index < samples.length - 1; index += 1) {
    const left = samples[index];
    const right = samples[index + 1];
    const score = pairScore(left, right, scoreCache);
    const state = classifyContinuity(score);
    if (state === 'good') goodCount += 1;
    else if (state === 'weak') weakCount += 1;
    else attentionCount += 1;
    pairs.push({ start: left.time, end: right.time, score, state });
  }

  renderContinuityResult({ plan, samples, additions, pairs, goodCount, attentionCount, weakCount, duration });
  setProgress(65, '連続性チェックが完了しました');

  return { plan, samples, additions, pairs, goodCount, attentionCount, weakCount };
}

function renderContinuityResult({ plan, samples, additions, pairs, goodCount, attentionCount, weakCount, duration }) {
  continuityMode.textContent = plan.mode;
  continuityCount.textContent = `${samples.length}枚`;
  continuityAdded.textContent = `${additions}枚`;
  continuityWeak.textContent = weakCount ? `${weakCount}区間` : 'なし';
  continuityTimeline.replaceChildren();

  pairs.forEach((pair) => {
    const segment = document.createElement('div');
    segment.className = `continuity-segment ${pair.state}`;
    const span = Math.max(0.5, pair.end - pair.start);
    segment.style.flexGrow = String(span);
    segment.title = `${pair.start.toFixed(1)}〜${pair.end.toFixed(1)}秒`;
    segment.setAttribute('aria-label', `${pair.start.toFixed(1)}秒から${pair.end.toFixed(1)}秒: ${pair.state}`);
    continuityTimeline.append(segment);
  });

  continuityMessage.hidden = false;
  const pairCount = Math.max(1, pairs.length);
  const weakRatio = weakCount / pairCount;
  const attentionRatio = attentionCount / pairCount;

  if (weakRatio <= 0.1 && attentionRatio <= 0.35) {
    continuityMessage.className = 'message-box success';
    continuityMessage.textContent = '画像同士のつながりは概ね良好です。続けて、透視画像に展開して局所的な対応点を確認します。';
  } else if (weakRatio <= 0.3) {
    continuityMessage.className = 'message-box warning';
    continuityMessage.textContent = '多くの区間はつながっていますが、一部で画像のつながりが弱い可能性があります。弱い区間も含めて局所特徴点を確認します。';
  } else {
    continuityMessage.className = 'message-box warning';
    continuityMessage.textContent = '画像のつながりが弱い区間が複数あります。長い移動、急な向きの変化、暗さ、被写体の少なさなどが影響している可能性があります。局所特徴点でも確認します。';
  }

  if (duration > 300 && samples.length >= plan.budget - 1 && weakCount > 0) {
    const note = document.createElement('p');
    note.className = 'continuity-long-note';
    note.textContent = '長時間動画のため、ブラウザ負荷を抑える上限まで解析しました。弱い区間は後段で必要に応じて自動分割・追加解析します。';
    continuityMessage.insertAdjacentElement('afterend', note);
  }
}

function featureKeyframeLimit(duration) {
  if (duration <= 60) return 18;
  if (duration <= 300) return 28;
  return 40;
}

function selectFeatureTimes(continuityResult, duration) {
  const samples = continuityResult.samples;
  const limit = Math.min(featureKeyframeLimit(duration), samples.length);
  if (samples.length <= limit) return samples.map((sample) => sample.time);

  const selected = new Set([0, samples.length - 1]);

  continuityResult.pairs.forEach((pair, index) => {
    if (pair.state !== 'good') {
      selected.add(index);
      selected.add(index + 1);
    }
  });

  if (selected.size > limit) {
    const priority = Array.from(selected).sort((a, b) => a - b);
    const thinned = new Set([0, samples.length - 1]);
    const slots = Math.max(0, limit - 2);
    for (let i = 0; i < slots; i += 1) {
      const pos = slots <= 1 ? 0 : i / (slots - 1);
      const idx = priority[Math.round(pos * (priority.length - 1))];
      thinned.add(idx);
    }
    return Array.from(thinned).sort((a, b) => a - b).map((index) => samples[index].time);
  }

  let cursor = 0;
  while (selected.size < limit && cursor < limit * 3) {
    const position = cursor / Math.max(1, limit * 3 - 1);
    selected.add(Math.round(position * (samples.length - 1)));
    cursor += 1;
  }

  if (selected.size < limit) {
    for (let index = 0; index < samples.length && selected.size < limit; index += 1) {
      selected.add(index);
    }
  }

  return Array.from(selected).sort((a, b) => a - b).map((index) => samples[index].time);
}

function getPerspectiveMaps() {
  if (perspectiveMapCache) return perspectiveMapCache;

  const maps = [];
  const size = FEATURE_VIEW_SIZE;
  const sourceWidth = FEATURE_EQ_WIDTH;
  const sourceHeight = FEATURE_EQ_HEIGHT;
  const halfFov = Math.tan((FEATURE_FOV_DEG * Math.PI / 180) / 2);

  FEATURE_VIEW_YAWS.forEach((yawDeg) => {
    const yaw = yawDeg * Math.PI / 180;
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const map = new Uint32Array(size * size);

    for (let y = 0; y < size; y += 1) {
      const ny = ((y + 0.5) / size * 2 - 1) * halfFov;
      for (let x = 0; x < size; x += 1) {
        const nx = ((x + 0.5) / size * 2 - 1) * halfFov;

        let vx = nx;
        let vy = -ny;
        let vz = 1;
        const length = Math.hypot(vx, vy, vz);
        vx /= length;
        vy /= length;
        vz /= length;

        const worldX = vx * cosYaw + vz * sinYaw;
        const worldZ = -vx * sinYaw + vz * cosYaw;
        const longitude = Math.atan2(worldX, worldZ);
        const latitude = Math.asin(Math.max(-1, Math.min(1, vy)));

        let sourceX = Math.floor((longitude / (Math.PI * 2) + 0.5) * sourceWidth);
        sourceX = ((sourceX % sourceWidth) + sourceWidth) % sourceWidth;
        const sourceY = Math.max(0, Math.min(sourceHeight - 1, Math.floor((0.5 - latitude / Math.PI) * sourceHeight)));
        map[y * size + x] = sourceY * sourceWidth + sourceX;
      }
    }
    maps.push(map);
  });

  perspectiveMapCache = maps;
  return maps;
}

async function captureFeaturePanorama(time) {
  await seekVideo(time);
  canvas.width = FEATURE_EQ_WIDTH;
  canvas.height = FEATURE_EQ_HEIGHT;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(video, 0, 0, FEATURE_EQ_WIDTH, FEATURE_EQ_HEIGHT);
  const imageData = context.getImageData(0, 0, FEATURE_EQ_WIDTH, FEATURE_EQ_HEIGHT);
  const gray = new Uint8Array(FEATURE_EQ_WIDTH * FEATURE_EQ_HEIGHT);

  for (let i = 0, p = 0; i < imageData.data.length; i += 4, p += 1) {
    gray[p] = Math.round(0.299 * imageData.data[i] + 0.587 * imageData.data[i + 1] + 0.114 * imageData.data[i + 2]);
  }

  return gray;
}

function projectPerspective(gray, map) {
  const output = new Uint8Array(map.length);
  for (let index = 0; index < map.length; index += 1) output[index] = gray[map[index]];
  return output;
}

function cornerResponse(gray, size, x, y) {
  let a = 0;
  let b = 0;
  let c = 0;

  for (let dy = -2; dy <= 2; dy += 1) {
    const row = (y + dy) * size;
    for (let dx = -2; dx <= 2; dx += 1) {
      const px = x + dx;
      const gx = gray[row + px + 1] - gray[row + px - 1];
      const gy = gray[row + size + px] - gray[row - size + px];
      a += gx * gx;
      b += gy * gy;
      c += gx * gy;
    }
  }

  const trace = a + b;
  const determinantTerm = Math.sqrt(Math.max(0, (a - b) * (a - b) + 4 * c * c));
  return (trace - determinantTerm) / 2;
}

function makePatchDescriptor(gray, size, x, y) {
  const raw = new Float32Array(FEATURE_PATCH_OFFSETS.length * FEATURE_PATCH_OFFSETS.length);
  let index = 0;
  let mean = 0;

  for (const dy of FEATURE_PATCH_OFFSETS) {
    for (const dx of FEATURE_PATCH_OFFSETS) {
      const value = gray[(y + dy) * size + (x + dx)];
      raw[index] = value;
      mean += value;
      index += 1;
    }
  }

  mean /= raw.length;
  let variance = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const delta = raw[i] - mean;
    variance += delta * delta;
  }
  const std = Math.sqrt(variance / raw.length);
  if (std < 8) return null;

  for (let i = 0; i < raw.length; i += 1) raw[i] = (raw[i] - mean) / std;
  return raw;
}

function detectLocalFeatures(gray, size) {
  const candidates = [];
  const margin = 8;

  for (let y = margin; y < size - margin; y += 3) {
    for (let x = margin; x < size - margin; x += 3) {
      const response = cornerResponse(gray, size, x, y);
      if (response > 1800) candidates.push({ x, y, response });
    }
  }

  candidates.sort((a, b) => b.response - a.response);
  const features = [];

  for (const candidate of candidates) {
    let tooClose = false;
    for (const existing of features) {
      const dx = candidate.x - existing.x;
      const dy = candidate.y - existing.y;
      if (dx * dx + dy * dy < FEATURE_MIN_DISTANCE * FEATURE_MIN_DISTANCE) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    const descriptor = makePatchDescriptor(gray, size, candidate.x, candidate.y);
    if (!descriptor) continue;
    features.push({ ...candidate, descriptor });
    if (features.length >= FEATURE_MAX_POINTS) break;
  }

  return features;
}

function descriptorDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    sum += delta * delta;
  }
  return sum;
}

function nearestTwo(feature, targets) {
  let bestIndex = -1;
  let best = Infinity;
  let second = Infinity;

  for (let index = 0; index < targets.length; index += 1) {
    const distance = descriptorDistance(feature.descriptor, targets[index].descriptor);
    if (distance < best) {
      second = best;
      best = distance;
      bestIndex = index;
    } else if (distance < second) {
      second = distance;
    }
  }

  return { bestIndex, best, second };
}

function matchSingleViews(leftFeatures, rightFeatures) {
  if (leftFeatures.length < 5 || rightFeatures.length < 5) return [];

  const forward = leftFeatures.map((feature) => nearestTwo(feature, rightFeatures));
  const reverse = rightFeatures.map((feature) => nearestTwo(feature, leftFeatures));
  const matches = [];

  forward.forEach((candidate, leftIndex) => {
    if (candidate.bestIndex < 0 || !Number.isFinite(candidate.second)) return;
    if (candidate.best > candidate.second * 0.78) return;

    const back = reverse[candidate.bestIndex];
    if (!back || back.bestIndex !== leftIndex || !Number.isFinite(back.second)) return;
    if (back.best > back.second * 0.82) return;

    const left = leftFeatures[leftIndex];
    const right = rightFeatures[candidate.bestIndex];
    matches.push({
      leftX: left.x,
      leftY: left.y,
      rightX: right.x,
      rightY: right.y,
      distance: candidate.best,
    });
  });

  return matches;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compareFeatureFrames(left, right) {
  let totalMatches = 0;
  let matchedDirections = 0;
  const residuals = [];

  left.views.forEach((leftView) => {
    let best = null;

    right.views.forEach((rightView) => {
      const matches = matchSingleViews(leftView.features, rightView.features);
      if (!best || matches.length > best.matches.length) {
        best = { matches, rightView };
      }
    });

    if (!best || best.matches.length < 3) return;

    matchedDirections += 1;
    totalMatches += best.matches.length;

    const dx = best.matches.map((match) => match.rightX - match.leftX);
    const dy = best.matches.map((match) => match.rightY - match.leftY);
    const medianDx = median(dx);
    const medianDy = median(dy);

    best.matches.forEach((match) => {
      residuals.push(Math.hypot(
        (match.rightX - match.leftX) - medianDx,
        (match.rightY - match.leftY) - medianDy,
      ));
    });
  });

  const residual = median(residuals);
  let state = 'attention';
  if (totalMatches >= FEATURE_GOOD_MATCHES && matchedDirections >= 2) state = 'good';
  else if (totalMatches < FEATURE_WEAK_MATCHES || matchedDirections === 0) state = 'weak';

  return {
    matches: totalMatches,
    matchedDirections,
    residual,
    parallaxCandidate: totalMatches >= FEATURE_WEAK_MATCHES && residual >= PARALLAX_PROXY_THRESHOLD,
    state,
  };
}

async function buildFeatureFrame(time, maps) {
  const panorama = await captureFeaturePanorama(time);
  const views = maps.map((map, index) => {
    const gray = projectPerspective(panorama, map);
    const features = detectLocalFeatures(gray, FEATURE_VIEW_SIZE);
    return {
      yaw: FEATURE_VIEW_YAWS[index],
      features,
    };
  });

  return { time, views };
}

function renderFeatureResult({ frames, pairs, weakCount, parallaxCount, duration }) {
  featurePanel.hidden = false;
  featureFrames.textContent = `${frames.length}枚`;
  featurePairs.textContent = `${pairs.length}組`;
  featureWeak.textContent = weakCount ? `${weakCount}組` : 'なし';
  featureParallax.textContent = parallaxCount ? `${parallaxCount}組` : '未確認';
  featureTimeline.replaceChildren();

  pairs.forEach((pair) => {
    const segment = document.createElement('div');
    segment.className = `feature-segment ${pair.state}`;
    segment.style.flexGrow = String(Math.max(0.5, pair.end - pair.start));
    segment.title = `${pair.start.toFixed(1)}〜${pair.end.toFixed(1)}秒：対応点 ${pair.matches}`;
    featureTimeline.append(segment);
  });

  featureMessage.hidden = false;
  const weakRatio = weakCount / Math.max(1, pairs.length);

  if (weakRatio <= 0.15 && parallaxCount > 0) {
    featureMessage.className = 'message-box success';
    featureMessage.textContent = '透視画像上で局所的な対応点を概ね取得でき、複数区間で視差の候補も確認できました。次は対応点から実際のカメラ姿勢を推定する工程へ進みます。';
  } else if (weakRatio <= 0.35) {
    featureMessage.className = 'message-box warning';
    featureMessage.textContent = '多くの区間で局所対応点を取得できましたが、一部は対応が弱い状態です。次工程では弱い区間を自動分割候補として扱いながら姿勢推定を行います。';
  } else {
    featureMessage.className = 'message-box warning';
    featureMessage.textContent = '局所対応点が少ない区間が複数あります。撮影移動が速い、模様が少ない、動く被写体が多いなどの影響が考えられます。次工程では区間分割と追加キーフレームを併用します。';
  }

  if (duration > 300) {
    const note = document.createElement('p');
    note.className = 'feature-long-note';
    note.textContent = '長時間動画では、連続性チェックで選ばれたキーフレームだけを局所解析しています。全フレームをメモリに保持していません。';
    featureMessage.insertAdjacentElement('afterend', note);
  }
}

async function runFeatureAnalysis(continuityResult, duration, generation) {
  clearFeatureAnalysis();
  featurePanel.hidden = false;
  featureFrames.textContent = '準備中';
  featurePairs.textContent = '—';
  featureWeak.textContent = '確認中';
  featureParallax.textContent = '確認中';

  const times = selectFeatureTimes(continuityResult, duration);
  const maps = getPerspectiveMaps();
  const frames = [];

  setProgress(67, '360°画像を透視画像へ展開しています');

  for (let index = 0; index < times.length; index += 1) {
    if (generation !== analysisGeneration) return null;
    frames.push(await buildFeatureFrame(times[index], maps));
    const percent = 67 + ((index + 1) / times.length) * 23;
    setProgress(percent, `局所特徴点を抽出しています (${index + 1}/${times.length})`);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  const pairs = [];
  let weakCount = 0;
  let parallaxCount = 0;

  for (let index = 0; index < frames.length - 1; index += 1) {
    if (generation !== analysisGeneration) return null;
    const result = compareFeatureFrames(frames[index], frames[index + 1]);
    if (result.state === 'weak') weakCount += 1;
    if (result.parallaxCandidate) parallaxCount += 1;
    pairs.push({
      start: frames[index].time,
      end: frames[index + 1].time,
      ...result,
    });
    const percent = 90 + ((index + 1) / Math.max(1, frames.length - 1)) * 10;
    setProgress(percent, `対応点を確認しています (${index + 1}/${Math.max(1, frames.length - 1)})`);
  }

  renderFeatureResult({ frames, pairs, weakCount, parallaxCount, duration });
  setProgress(100, '局所特徴点チェックまで完了しました');
  return { frames, pairs, weakCount, parallaxCount };
}

async function analyzeVideo(file) {
  hideMessage();
  analysisPanel.hidden = true;
  clearFrames();
  clearContinuity();
  clearFeatureAnalysis();

  if (!file || !supportedVideo(file)) {
    showMessage('error', '動画ファイルを選んでください。Insta360 Studioから書き出したMP4を推奨します。');
    return;
  }

  cleanup();
  const generation = analysisGeneration;
  currentUrl = URL.createObjectURL(file);
  video.src = currentUrl;
  video.preload = 'metadata';

  setProgress(6, '動画を確認しています');

  try {
    await waitForEvent(video, 'loadedmetadata', 15000);
    if (generation !== analysisGeneration) return;

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

    setProgress(15, '代表画像を準備しています');
    const times = choosePreviewTimes(duration);
    for (let index = 0; index < times.length; index += 1) {
      if (generation !== analysisGeneration) return;
      await capturePreviewFrame(times[index], index, times.length);
    }

    if (resolutionOk && durationOk) {
      showMessage('success', '360°動画として認識しました。連続性と局所特徴点を順番に自動確認します。');
      const continuityResult = await runAdaptiveContinuity(duration, generation);
      if (!continuityResult || generation !== analysisGeneration) return;
      await runFeatureAnalysis(continuityResult, duration, generation);
    } else {
      setProgress(100, '素材の確認が完了しました');
      showMessage('warning', '360°動画として読み込めましたが、3D化には素材が不足する可能性があります。できれば5秒以上、より高い解像度で撮影してください。');
    }
  } catch (error) {
    if (generation !== analysisGeneration) return;
    setProgress(0, '読み込みできませんでした');
    analysisPanel.hidden = true;
    clearContinuity();
    clearFeatureAnalysis();
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
