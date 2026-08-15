const dsSourceVideo = document.querySelector('#source-video');
const dsProgressText = document.querySelector('#progress-text');

let dsGeneration = 0;
let dsLastSignature = '';
let dsRunning = false;
let dsPreviewUrls = [];

const DS_FOV_DEG = 100;
const DS_YAWS = [0, 90, 180, 270];
const DS_LABELS = ['front', 'right', 'back', 'left'];
const DS_JPEG_QUALITY = 0.90;
const DS_MAX_BASE_FRAMES = 24;
const DS_QA_SAMPLE_SIZE = 64;
const DS_QA_MIN_STD = 4.0;
const DS_QA_MIN_RANGE = 18;
const DS_QA_MIN_MEDIAN_STD = 6.0;
const DS_QA_MIN_MEDIAN_RANGE = 30;
const DS_QA_MIN_MEDIAN_BYTES = 8000;

function dsClamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function dsMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function dsMatMul3(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) {
    out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return out;
}
function dsTranspose3(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
function dsMatVec3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
function dsScale3(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
function dsYawMatrix(yawDeg) {
  const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
function dsRotationToQuaternion(R) {
  const tr = R[0] + R[4] + R[8]; let qw, qx, qy, qz;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; qw = 0.25 * s; qx = (R[7] - R[5]) / s; qy = (R[2] - R[6]) / s; qz = (R[3] - R[1]) / s; }
  else if (R[0] > R[4] && R[0] > R[8]) { const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2; qw = (R[7] - R[5]) / s; qx = 0.25 * s; qy = (R[1] + R[3]) / s; qz = (R[2] + R[6]) / s; }
  else if (R[4] > R[8]) { const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2; qw = (R[2] - R[6]) / s; qx = (R[1] + R[3]) / s; qy = 0.25 * s; qz = (R[5] + R[7]) / s; }
  else { const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2; qw = (R[3] - R[1]) / s; qx = (R[2] + R[6]) / s; qy = (R[5] + R[7]) / s; qz = 0.25 * s; }
  const n = Math.hypot(qw, qx, qy, qz) || 1;
  return [qw / n, qx / n, qy / n, qz / n];
}
function dsChooseImageSize(frameCount) {
  const memory = navigator.deviceMemory || 4;
  if (memory >= 8 && frameCount <= 14) return 1024;
  if (memory >= 4 && frameCount <= 20) return 768;
  return 640;
}
function dsSelectIndices(count) {
  if (count <= DS_MAX_BASE_FRAMES) return Array.from({ length: count }, (_, i) => i);
  const out = [];
  for (let i = 0; i < DS_MAX_BASE_FRAMES; i += 1) out.push(Math.round(i * (count - 1) / (DS_MAX_BASE_FRAMES - 1)));
  return [...new Set(out)];
}

function dsEnsurePanel() {
  let panel = document.querySelector('#dataset-panel');
  if (panel) return panel;
  const baPanel = document.querySelector('#ba-panel');
  if (!baPanel) return null;
  panel = document.createElement('section');
  panel.id = 'dataset-panel'; panel.className = 'dataset-panel'; panel.hidden = true;
  panel.innerHTML = `<div class="dataset-heading"><div><p class="eyebrow">3DGS学習データの準備</p><h3>最適化済みの360°動画から学習用データセットを作成</h3></div><span class="dataset-auto">自動設定</span></div><p class="dataset-description">最適化が良好な区間だけを使い、各360°キーフレームを前・右・後・左の4方向へ高画質な透視画像として展開します。生成後に画像の情報量を自動検査し、正常な場合だけCOLMAP形式と初期疎点群をZIPにまとめます。</p><div class="dataset-stats"><div><span>対象区間</span><strong id="dataset-count">—</strong></div><div><span>元キーフレーム</span><strong id="dataset-frames">—</strong></div><div><span>学習画像</span><strong id="dataset-images">—</strong></div><div><span>出力解像度</span><strong id="dataset-size">—</strong></div></div><div id="dataset-list" class="dataset-list"></div><div id="dataset-message" class="message-box" hidden></div><p class="dataset-note">元の360°動画と生成画像はこの端末内だけで処理します。カメラ移動の絶対距離スケールは未確定のため、出力データも任意スケールです。</p>`;
  baPanel.insertAdjacentElement('afterend', panel);
  return panel;
}
function dsSetMessage(text, kind = 'warning') {
  const box = dsEnsurePanel()?.querySelector('#dataset-message');
  if (!box) return;
  box.hidden = false; box.className = `message-box ${kind}`; box.textContent = text;
}

async function dsSeek(time) {
  if (!dsSourceVideo || !Number.isFinite(dsSourceVideo.duration)) throw new Error('動画を確認できません。');
  const bounded = dsClamp(time, 0, Math.max(0, dsSourceVideo.duration - 0.001));
  if (Math.abs(dsSourceVideo.currentTime - bounded) < 0.008 && dsSourceVideo.readyState >= 2) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('学習画像用フレームの読み込みに時間がかかっています。')); }, 12000);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('動画フレームを読み込めませんでした。')); };
    const cleanup = () => { clearTimeout(timer); dsSourceVideo.removeEventListener('seeked', done); dsSourceVideo.removeEventListener('error', fail); };
    dsSourceVideo.addEventListener('seeked', done, { once: true });
    dsSourceVideo.addEventListener('error', fail, { once: true });
    dsSourceVideo.currentTime = bounded;
  });
}

function dsCreateRenderer(size) {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const gl = canvas.getContext('webgl', { alpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('このブラウザでは学習画像の透視変換に必要なWebGLを利用できません。');
  const vs = `attribute vec2 aPos; varying vec2 vUv; void main(){vUv=aPos*0.5+0.5; gl_Position=vec4(aPos,0.0,1.0);}`;
  const fs = `precision highp float; varying vec2 vUv; uniform sampler2D uPano; uniform float uYaw; uniform float uHalfFov; const float PI=3.141592653589793; void main(){vec3 local=normalize(vec3((vUv.x*2.0-1.0)*uHalfFov,(vUv.y*2.0-1.0)*uHalfFov,1.0));float c=cos(uYaw),s=sin(uYaw);vec3 d=vec3(local.x*c+local.z*s,local.y,-local.x*s+local.z*c);float lon=atan(d.x,d.z);float lat=asin(clamp(d.y,-1.0,1.0));float u=clamp(lon/(2.0*PI)+0.5,0.0,1.0);float v=clamp(lat/PI+0.5,0.0,1.0);gl_FragColor=texture2D(uPano,vec2(u,v));}`;
  const compile = (type, src) => {
    const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'WebGL shader error');
    return sh;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'WebGL program error');
  gl.useProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // WebGL1ではNPOT動画テクスチャにREPEATを使えない。Insta360の3840x1920等を黒画像にしないためCLAMP_TO_EDGEを使う。
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.uniform1i(gl.getUniformLocation(program, 'uPano'), 0);
  gl.uniform1f(gl.getUniformLocation(program, 'uHalfFov'), Math.tan(DS_FOV_DEG * Math.PI / 360));
  const yawLoc = gl.getUniformLocation(program, 'uYaw'); gl.viewport(0, 0, size, size);
  return {
    canvas,
    render(video, yawDeg) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      const uploadError = gl.getError();
      if (uploadError !== gl.NO_ERROR) throw new Error(`動画テクスチャをWebGLへ転送できませんでした (${uploadError})。`);
      gl.uniform1f(yawLoc, yawDeg * Math.PI / 180); gl.drawArrays(gl.TRIANGLES, 0, 6); gl.finish();
      const renderError = gl.getError();
      if (renderError !== gl.NO_ERROR) throw new Error(`透視画像を描画できませんでした (${renderError})。`);
    },
  };
}
function dsCanvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('学習画像を書き出せませんでした。')), 'image/jpeg', DS_JPEG_QUALITY));
}
function dsAnalyzeCanvas(canvas) {
  const sample = document.createElement('canvas'); sample.width = DS_QA_SAMPLE_SIZE; sample.height = DS_QA_SAMPLE_SIZE;
  const ctx = sample.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, DS_QA_SAMPLE_SIZE, DS_QA_SAMPLE_SIZE);
  const pixels = ctx.getImageData(0, 0, DS_QA_SAMPLE_SIZE, DS_QA_SAMPLE_SIZE).data;
  const values = []; let sum = 0, dark = 0, bright = 0, min = 255, max = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const y = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    values.push(y); sum += y; if (y < 5) dark += 1; if (y > 250) bright += 1; min = Math.min(min, y); max = Math.max(max, y);
  }
  const mean = sum / Math.max(1, values.length);
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, values.length);
  const std = Math.sqrt(variance), range = max - min;
  const darkFraction = dark / Math.max(1, values.length), brightFraction = bright / Math.max(1, values.length);
  return { mean, std, range, darkFraction, brightFraction, good: std >= DS_QA_MIN_STD && range >= DS_QA_MIN_RANGE && darkFraction < 0.995 && brightFraction < 0.995 };
}
function dsEvaluateQuality(stats) {
  const invalid = stats.filter((s) => !s.good);
  const medianStd = dsMedian(stats.map((s) => s.std));
  const medianRange = dsMedian(stats.map((s) => s.range));
  const medianBytes = dsMedian(stats.map((s) => s.bytes || 0));
  const invalidRate = invalid.length / Math.max(1, stats.length);
  const ok = invalidRate <= 0.10 && medianStd >= DS_QA_MIN_MEDIAN_STD && medianRange >= DS_QA_MIN_MEDIAN_RANGE && medianBytes >= DS_QA_MIN_MEDIAN_BYTES;
  return { ok, invalidCount: invalid.length, invalidRate, medianStd, medianRange, medianBytes };
}

const dsCrcTable = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function dsCrc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = dsCrcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function dsU16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
function dsU32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
function dsConcat(parts) { const length = parts.reduce((s, p) => s + p.length, 0), out = new Uint8Array(length); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
function dsDosTime(date = new Date()) { const year = Math.max(1980, date.getFullYear()); return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() }; }
async function dsMakeZip(files) {
  const enc = new TextEncoder(), locals = [], centrals = []; let offset = 0; const dt = dsDosTime();
  for (const file of files) {
    const name = enc.encode(file.name), data = file.data instanceof Uint8Array ? file.data : new Uint8Array(await file.data.arrayBuffer()), crc = dsCrc32(data);
    const local = dsConcat([dsU32(0x04034b50),dsU16(20),dsU16(0x0800),dsU16(0),dsU16(dt.time),dsU16(dt.date),dsU32(crc),dsU32(data.length),dsU32(data.length),dsU16(name.length),dsU16(0),name,data]);
    locals.push(local);
    const central = dsConcat([dsU32(0x02014b50),dsU16(20),dsU16(20),dsU16(0x0800),dsU16(0),dsU16(dt.time),dsU16(dt.date),dsU32(crc),dsU32(data.length),dsU32(data.length),dsU16(name.length),dsU16(0),dsU16(0),dsU16(0),dsU16(0),dsU32(0),dsU32(offset),name]);
    centrals.push(central); offset += local.length;
  }
  const centralOffset = offset, centralSize = centrals.reduce((s, p) => s + p.length, 0);
  const end = dsConcat([dsU32(0x06054b50),dsU16(0),dsU16(0),dsU16(files.length),dsU16(files.length),dsU32(centralSize),dsU32(centralOffset),dsU16(0)]);
  return new Blob([...locals,...centrals,end], { type: 'application/zip' });
}
function dsTextFile(name, text) { return { name, data: new TextEncoder().encode(text) }; }
function dsPly(tracks) {
  const clean = tracks.filter((t) => t.position?.every(Number.isFinite)).slice(0, 5000);
  const header = `ply\nformat ascii 1.0\nelement vertex ${clean.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  const body = clean.map((t) => `${t.position[0]} ${t.position[1]} ${t.position[2]} 160 160 160`).join('\n');
  return new TextEncoder().encode(header + body + (body ? '\n' : ''));
}
function dsColmapTexts(item, selected, size) {
  const focal = (size / 2) / Math.tan(DS_FOV_DEG * Math.PI / 360), cx = size / 2, cy = size / 2;
  const camera = `# Camera list with one line of data per camera:\n# CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n# Number of cameras: 1\n1 PINHOLE ${size} ${size} ${focal.toFixed(8)} ${focal.toFixed(8)} ${cx.toFixed(8)} ${cy.toFixed(8)}\n`;
  const lines = ['# Image list with two lines of data per image:','# IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',`# Number of images: ${selected.length * 4}`], imageRecords = []; let imageId = 1;
  selected.forEach((frameIndex, order) => {
    const pose = item.optimization.poses[frameIndex];
    for (let d = 0; d < 4; d += 1) {
      const yaw = DS_YAWS[d], c2w = dsMatMul3(pose.cameraToWorld, dsYawMatrix(yaw)), R = dsTranspose3(c2w), t = dsScale3(dsMatVec3(R, pose.position), -1), q = dsRotationToQuaternion(R), name = `f${String(order).padStart(3,'0')}_${DS_LABELS[d]}.jpg`;
      lines.push(`${imageId} ${q[0]} ${q[1]} ${q[2]} ${q[3]} ${t[0]} ${t[1]} ${t[2]} 1 ${name}`); lines.push('');
      imageRecords.push({ imageId, frameIndex, yaw, name, time: item.source.frames[frameIndex].time }); imageId += 1;
    }
  });
  const points = '# 3D point list with one line of data per point:\n# POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[]\n# Number of points: 0\n';
  return { camera, images: lines.join('\n') + '\n', points, imageRecords };
}

async function dsBuildDataset(item, card, generation) {
  const poses = item.optimization.poses, selected = dsSelectIndices(Math.min(poses.length, item.source.frames.length));
  const size = dsChooseImageSize(selected.length), renderer = dsCreateRenderer(size), colmap = dsColmapTexts(item, selected, size);
  const files = [dsTextFile('sparse/0/cameras.txt', colmap.camera),dsTextFile('sparse/0/images.txt', colmap.images),dsTextFile('sparse/0/points3D.txt', colmap.points),{ name: 'init.ply', data: dsPly(item.optimization.tracks) }];
  const qualityStats = [], previewBlobs = []; let totalImageBytes = 0;
  let completed = 0;
  for (const record of colmap.imageRecords) {
    if (generation !== dsGeneration) return null;
    await dsSeek(record.time); renderer.render(dsSourceVideo, record.yaw);
    const qa = dsAnalyzeCanvas(renderer.canvas), blob = await dsCanvasBlob(renderer.canvas);
    qa.bytes = blob.size; qa.name = record.name; qualityStats.push(qa); totalImageBytes += blob.size;
    if (completed < 4) previewBlobs.push({ name: record.name, blob, qa });
    files.push({ name:`images/${record.name}`, data:blob }); completed += 1;
    const pct = Math.round(completed / colmap.imageRecords.length * 100), progress = card.querySelector('.dataset-card-progress');
    if (progress) progress.textContent = `学習画像を作成・検査中 ${completed}/${colmap.imageRecords.length} (${pct}%)`;
    if (dsProgressText) dsProgressText.textContent = `3DGS学習画像を作成・検査しています ${completed}/${colmap.imageRecords.length}`;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (generation !== dsGeneration) return null;
  const quality = dsEvaluateQuality(qualityStats);
  const metadata = {
    format:'360GS-COLMAP', version:'0.3a1', segmentId:item.source.segment.id, segmentStart:item.source.segment.start, segmentEnd:item.source.segment.end,
    sourceFrames:selected.length, trainingImages:selected.length*4, imageSize:size, fovDeg:DS_FOV_DEG, yawsDeg:DS_YAWS, arbitraryScale:true, absoluteMetricScale:false,
    optimizedMedianAngularErrorDeg:item.optimization.final.medianDeg, optimizedRmsAngularErrorDeg:item.optimization.final.rmsDeg,
    imageQuality:{ ok:quality.ok, invalidImages:quality.invalidCount, invalidRate:quality.invalidRate, medianLuminanceStd:quality.medianStd, medianLuminanceRange:quality.medianRange, medianJpegBytes:quality.medianBytes, totalJpegBytes:totalImageBytes },
  };
  files.push(dsTextFile('dataset.json', JSON.stringify(metadata, null, 2)));
  files.push(dsTextFile('README.txt', '360GS v0.3a1 training dataset\n\nimages/: perspective training images\nsparse/0/: COLMAP text camera model\ninit.ply: optimized sparse points for Gaussian initialization\n\nPerspective images passed automatic image-quality checks. Camera translation has arbitrary scale.\n'));
  const zip = quality.ok ? await dsMakeZip(files) : null;
  return { zip, metadata, selected, size, imageCount:colmap.imageRecords.length, quality, previewBlobs, totalImageBytes };
}
function dsDownload(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function dsRenderPreview(card, built) {
  const old = card.querySelector('.dataset-preview'); if (old) old.remove();
  const wrap = document.createElement('div'); wrap.className = 'dataset-preview';
  for (const item of built.previewBlobs) {
    const url = URL.createObjectURL(item.blob); dsPreviewUrls.push(url);
    const figure = document.createElement('figure');
    figure.innerHTML = `<img src="${url}" alt="${item.name} の確認画像"><figcaption>${item.name}<br>情報量 ${item.qa.std.toFixed(1)}</figcaption>`;
    wrap.append(figure);
  }
  card.querySelector('.dataset-card-progress')?.insertAdjacentElement('afterend', wrap);
}

async function dsRun(detail) {
  if (dsRunning || !detail?.good?.length || !dsSourceVideo) return;
  const signature = `${dsSourceVideo.currentSrc || dsSourceVideo.src}|${detail.good.map((x) => `${x.source.segment.id}-${x.optimization.poses.length}-${x.optimization.final.medianDeg.toFixed(4)}`).join('|')}`;
  if (signature === dsLastSignature) return;
  dsLastSignature = signature; dsRunning = true;
  const generation = ++dsGeneration, panel = dsEnsurePanel(); if (!panel) return;
  panel.hidden = false; const list = panel.querySelector('#dataset-list'); list.replaceChildren();
  const totalFrames = detail.good.reduce((s,item) => s + dsSelectIndices(item.optimization.poses.length).length, 0), totalImages = totalFrames * 4;
  panel.querySelector('#dataset-count').textContent = `${detail.good.length}区間`; panel.querySelector('#dataset-frames').textContent = `${totalFrames}枚`; panel.querySelector('#dataset-images').textContent = `${totalImages}枚`; panel.querySelector('#dataset-size').textContent = '自動';
  let readyCount = 0, failedCount = 0;
  try {
    for (let i = 0; i < detail.good.length; i += 1) {
      const item = detail.good[i], card = document.createElement('article'); card.className = 'dataset-card';
      card.innerHTML = `<div class="dataset-card-head"><div><span>候補区間 ${item.source.segment.id}</span><h4>${item.source.segment.start.toFixed(1)}秒 〜 ${item.source.segment.end.toFixed(1)}秒</h4></div><span class="dataset-badge">作成中</span></div><div class="dataset-card-progress">学習データを準備しています</div><div class="dataset-actions"></div>`;
      list.append(card);
      const built = await dsBuildDataset(item, card, generation); if (!built) return;
      dsRenderPreview(card, built);
      const badge = card.querySelector('.dataset-badge'), prog = card.querySelector('.dataset-card-progress'), actions = card.querySelector('.dataset-actions');
      panel.querySelector('#dataset-size').textContent = `${built.size}px`;
      const imageMb = built.totalImageBytes / 1024 / 1024;
      if (built.quality.ok && built.zip) {
        readyCount += 1; badge.textContent = '品質確認済み'; badge.classList.add('ready');
        prog.textContent = `${built.imageCount}枚・${built.size}px・画像 ${imageMb.toFixed(1)} MB・ZIP ${(built.zip.size/1024/1024).toFixed(1)} MB`;
        const qa = document.createElement('div'); qa.className = 'dataset-qa good'; qa.textContent = `画像品質: 正常 / 輝度分散中央値 ${built.quality.medianStd.toFixed(1)} / 不良候補 ${built.quality.invalidCount}枚`;
        actions.before(qa);
        const button = document.createElement('button'); button.type='button'; button.className='dataset-download'; button.textContent='学習データZIPを保存';
        button.addEventListener('click', () => dsDownload(built.zip, `360gs_segment_${item.source.segment.id}_colmap.zip`)); actions.append(button);
      } else {
        failedCount += 1; badge.textContent = '画像要確認'; badge.classList.add('failed');
        prog.textContent = `${built.imageCount}枚を生成しましたが、画像の情報量が不自然なためZIP保存を停止しました。`;
        const qa = document.createElement('div'); qa.className = 'dataset-qa warning';
        qa.textContent = `画像品質: 要確認 / 輝度分散中央値 ${built.quality.medianStd.toFixed(1)} / ダイナミックレンジ中央値 ${built.quality.medianRange.toFixed(1)} / JPEG中央値 ${(built.quality.medianBytes/1024).toFixed(1)} KB`;
        actions.before(qa);
      }
    }
    if (readyCount) {
      dsSetMessage(`${readyCount}区間で透視画像の品質まで確認できました。プレビューを目視確認したうえで「学習データZIPを保存」を利用できます。${failedCount ? ` ${failedCount}区間は画像品質のため保留しました。` : ''}`, 'success');
      if (dsProgressText) dsProgressText.textContent = '3DGS学習画像の品質確認まで完了しました';
    } else {
      dsSetMessage('生成した透視画像の品質に問題を検出したため、学習データの保存を停止しました。プレビューを確認してください。', 'warning');
      if (dsProgressText) dsProgressText.textContent = '学習画像の品質確認で問題を検出しました';
    }
    window.__360gsDatasetResult = { ready:readyCount > 0, count:readyCount, failedCount };
    window.dispatchEvent(new CustomEvent('360gs:dataset-ready', { detail:window.__360gsDatasetResult }));
  } catch (error) {
    dsSetMessage(error?.message || '3DGS学習用データセットを作成できませんでした。', 'warning');
    if (dsProgressText) dsProgressText.textContent = '学習用データセットを作成できませんでした';
  } finally { if (generation === dsGeneration) dsRunning = false; }
}
function dsReset() {
  dsGeneration += 1; dsRunning = false; dsLastSignature = ''; window.__360gsDatasetResult = null;
  for (const url of dsPreviewUrls) URL.revokeObjectURL(url); dsPreviewUrls = [];
  const panel = document.querySelector('#dataset-panel'); if (panel) panel.hidden = true;
}
window.addEventListener('360gs:ba-ready', (event) => window.setTimeout(() => dsRun(event.detail), 100));
dsSourceVideo?.addEventListener('loadedmetadata', dsReset);
if (window.__360gsBundleResult?.good?.length) window.setTimeout(() => dsRun(window.__360gsBundleResult), 100);
document.querySelectorAll('.version').forEach((node) => { node.textContent = 'Prototype v0.3a1'; });
const dsHeroEyebrow = document.querySelector('.video-hero .eyebrow'); if (dsHeroEyebrow) dsHeroEyebrow.textContent = 'Step 9 / 3DGS学習データの準備・画像品質確認';