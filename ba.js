const baSourceVideo = document.querySelector('#source-video');
const baProgressText = document.querySelector('#progress-text');

let baGeneration = 0;
let baRunning = false;
let baLastSignature = '';

const BA_VIEW_SIZE = 176;
const BA_FOV_DEG = 100;
const BA_MAX_TRACKS = 260;
const BA_MAX_OBSERVATIONS = 1400;
const BA_MIN_TRACK_LENGTH = 3;
const BA_MAX_ITERATIONS = 9;
const BA_HUBER_DEG = 1.8;
const BA_OUTLIER_DEG = 8.0;
const BA_PRUNE_MIN_DEG = 2.5;
const BA_PRUNE_MAX_DEG = 6.0;
const BA_POINT_EPS = 1e-4;
const BA_ROT_EPS = 2e-5;
const BA_TRANS_EPS = 1e-4;
const BA_GLOBAL_COST_TOL = 1e-5;
const BA_METRIC_TOL = 0.0025;

function baClamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function baNorm3(v) { return Math.hypot(v[0], v[1], v[2]); }
function baNormalize3(v) {
  const n = baNorm3(v);
  return !Number.isFinite(n) || n < 1e-12 ? [0, 0, 0] : [v[0] / n, v[1] / n, v[2] / n];
}
function baDot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function baAdd3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function baSub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function baScale3(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
function baCross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function baIdentity3() { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
function baTranspose3(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
function baMatVec3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}
function baMul3(a, b) {
  const out = new Array(9).fill(0);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}
function baMedian(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function baMad(values, center = baMedian(values)) {
  return baMedian(values.map((value) => Math.abs(value - center)));
}

function baSolveLinear(matrix, rhs, n) {
  const a = Array.from(matrix);
  const b = Array.from(rhs);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(a[r * n + col]) > Math.abs(a[pivot * n + col])) pivot = r;
    }
    if (Math.abs(a[pivot * n + col]) < 1e-10) return null;
    if (pivot !== col) {
      for (let c = col; c < n; c += 1) {
        [a[col * n + c], a[pivot * n + c]] = [a[pivot * n + c], a[col * n + c]];
      }
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const div = a[col * n + col];
    for (let c = col; c < n; c += 1) a[col * n + c] /= div;
    b[col] /= div;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = a[r * n + col];
      if (Math.abs(f) < 1e-14) continue;
      for (let c = col; c < n; c += 1) a[r * n + c] -= f * a[col * n + c];
      b[r] -= f * b[col];
    }
  }
  return b;
}

function baExpSO3(delta) {
  const theta = baNorm3(delta);
  if (theta < 1e-12) return baIdentity3();
  const [x, y, z] = delta.map((v) => v / theta);
  const c = Math.cos(theta), s = Math.sin(theta), t = 1 - c;
  return [
    t*x*x+c, t*x*y-s*z, t*x*z+s*y,
    t*x*y+s*z, t*y*y+c, t*y*z-s*x,
    t*x*z-s*y, t*y*z+s*x, t*z*z+c,
  ];
}

function baBearing(x, y, yawDeg) {
  const halfFov = Math.tan((BA_FOV_DEG * Math.PI / 180) / 2);
  const nx = ((x + 0.5) / BA_VIEW_SIZE * 2 - 1) * halfFov;
  const ny = ((y + 0.5) / BA_VIEW_SIZE * 2 - 1) * halfFov;
  const local = baNormalize3([nx, -ny, 1]);
  const yaw = yawDeg * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
  return baNormalize3([local[0] * c + local[2] * s, local[1], -local[0] * s + local[2] * c]);
}

function baDescriptorDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function baFlattenFrame(frame, frameIndex) {
  const observations = [];
  frame.views.forEach((view, viewIndex) => {
    view.features.forEach((feature, featureIndex) => observations.push({
      key: `${frameIndex}:${viewIndex}:${featureIndex}`,
      frameIndex,
      viewIndex,
      featureIndex,
      descriptor: feature.descriptor,
      response: feature.response || 0,
      bearing: Array.isArray(feature.bearing) && feature.bearing.length === 3
        ? baNormalize3(feature.bearing)
        : baBearing(feature.x, feature.y, view.yaw),
      spherical: !!feature.spherical,
    }));
  });
  return observations;
}

function baNearestTwo(source, targets) {
  let bestIndex = -1, best = Infinity, second = Infinity;
  for (let i = 0; i < targets.length; i += 1) {
    const d = baDescriptorDistance(source.descriptor, targets[i].descriptor);
    if (d < best) { second = best; best = d; bestIndex = i; }
    else if (d < second) second = d;
  }
  return { bestIndex, best, second };
}

function baMatchFrames(left, right) {
  if (left.length < 10 || right.length < 10) return [];
  const forward = left.map((x) => baNearestTwo(x, right));
  const reverse = right.map((x) => baNearestTwo(x, left));
  const matches = [];
  forward.forEach((m, i) => {
    if (m.bestIndex < 0 || !Number.isFinite(m.second) || m.best > m.second * 0.72) return;
    const back = reverse[m.bestIndex];
    if (!back || back.bestIndex !== i || !Number.isFinite(back.second) || back.best > back.second * 0.78) return;
    matches.push({ left: left[i], right: right[m.bestIndex], quality: m.best });
  });
  return matches;
}

class BAUnionFind {
  constructor() { this.parent = new Map(); }
  add(x) { if (!this.parent.has(x)) this.parent.set(x, x); }
  find(x) {
    const p = this.parent.get(x);
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a, b) {
    this.add(a); this.add(b);
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

function baBuildTracks(frames) {
  const flattened = frames.map(baFlattenFrame);
  const uf = new BAUnionFind();
  const lookup = new Map();
  flattened.flat().forEach((obs) => { uf.add(obs.key); lookup.set(obs.key, obs); });
  const connect = (i, j) => {
    const matches = baMatchFrames(flattened[i], flattened[j]);
    for (const match of matches) uf.union(match.left.key, match.right.key);
  };
  for (let i = 0; i < frames.length - 1; i += 1) connect(i, i + 1);
  for (let i = 0; i < frames.length - 2; i += 1) connect(i, i + 2);

  const groups = new Map();
  for (const obs of lookup.values()) {
    const root = uf.find(obs.key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(obs);
  }

  let tracks = [];
  for (const observations of groups.values()) {
    const byFrame = new Map();
    for (const obs of observations) {
      const existing = byFrame.get(obs.frameIndex);
      if (!existing || obs.response > existing.response) byFrame.set(obs.frameIndex, obs);
    }
    const unique = [...byFrame.values()].sort((a, b) => a.frameIndex - b.frameIndex);
    if (unique.length < BA_MIN_TRACK_LENGTH) continue;
    const span = unique[unique.length - 1].frameIndex - unique[0].frameIndex;
    if (span < 2) continue;
    const score = unique.length * 100000 + span * 10000 + unique.reduce((s, x) => s + x.response, 0) / unique.length;
    tracks.push({ observations: unique, score });
  }
  tracks.sort((a, b) => b.score - a.score);
  tracks = tracks.slice(0, BA_MAX_TRACKS);
  let observations = tracks.reduce((s, t) => s + t.observations.length, 0);
  while (observations > BA_MAX_OBSERVATIONS && tracks.length > 20) {
    const removed = tracks.pop();
    observations -= removed.observations.length;
  }
  return tracks;
}

function baClonePoses(cameraPoses) {
  return cameraPoses.map((pose) => ({
    position: [...pose.position],
    cameraToWorld: [...pose.cameraToWorld],
    time: pose.time,
    valid: pose.valid !== false,
  }));
}
function baCloneTracks(tracks) {
  return tracks.map((track) => ({
    ...track,
    observations: track.observations.map((obs) => ({ ...obs, bearing: [...obs.bearing] })),
    position: [...track.position],
  }));
}
function baCopyState(targetPoses, targetTracks, sourcePoses, sourceTracks) {
  for (let i = 0; i < targetPoses.length; i += 1) {
    targetPoses[i].position = [...sourcePoses[i].position];
    targetPoses[i].cameraToWorld = [...sourcePoses[i].cameraToWorld];
  }
  for (let i = 0; i < targetTracks.length; i += 1) targetTracks[i].position = [...sourceTracks[i].position];
}

function baRayWorld(pose, bearing) { return baNormalize3(baMatVec3(pose.cameraToWorld, bearing)); }

function baTriangulateTrack(track, poses) {
  const A = new Array(9).fill(0), b = [0, 0, 0];
  let valid = 0;
  for (const obs of track.observations) {
    const pose = poses[obs.frameIndex];
    if (!pose) continue;
    const d = baRayWorld(pose, obs.bearing), C = pose.position;
    const M = [
      1-d[0]*d[0], -d[0]*d[1], -d[0]*d[2],
      -d[1]*d[0], 1-d[1]*d[1], -d[1]*d[2],
      -d[2]*d[0], -d[2]*d[1], 1-d[2]*d[2],
    ];
    for (let i = 0; i < 9; i += 1) A[i] += M[i];
    const MC = baMatVec3(M, C);
    b[0] += MC[0]; b[1] += MC[1]; b[2] += MC[2];
    valid += 1;
  }
  if (valid < BA_MIN_TRACK_LENGTH) return null;
  const point = baSolveLinear(A, b, 3);
  if (!point || !point.every(Number.isFinite)) return null;
  let positive = 0;
  const depths = [];
  for (const obs of track.observations) {
    const pose = poses[obs.frameIndex], d = baRayWorld(pose, obs.bearing);
    const depth = baDot3(d, baSub3(point, pose.position));
    if (depth > 0) positive += 1;
    depths.push(depth);
  }
  if (positive / valid < 0.67 || baMedian(depths) <= 0 || baMedian(depths) > 80) return null;
  return point;
}

function baInitializeTracks(rawTracks, poses) {
  const tracks = [];
  for (const track of rawTracks) {
    const point = baTriangulateTrack(track, poses);
    if (point) tracks.push({ ...track, observations: track.observations.map((obs) => ({ ...obs })), position: point });
  }
  return tracks;
}

function baPredictedBearing(pose, point) {
  const world = baNormalize3(baSub3(point, pose.position));
  return baNormalize3(baMatVec3(baTranspose3(pose.cameraToWorld), world));
}
function baObservation(pose, point, observed) {
  const pred = baPredictedBearing(pose, point);
  const dot = baClamp(baDot3(pred, observed), -1, 1);
  const angle = Math.acos(dot);
  return { residual: [pred[0] - observed[0], pred[1] - observed[1], pred[2] - observed[2]], angle };
}
function baHuberWeight(angle) {
  const delta = BA_HUBER_DEG * Math.PI / 180;
  if (angle <= delta || angle < 1e-12) return 1;
  return delta / angle;
}
function baHuberCost(angle) {
  const delta = BA_HUBER_DEG * Math.PI / 180;
  return angle <= delta ? 0.5 * angle * angle : delta * (angle - 0.5 * delta);
}
function baTrackCost(track, poses, point = track.position) {
  let cost = 0;
  for (const obs of track.observations) cost += baHuberCost(baObservation(poses[obs.frameIndex], point, obs.bearing).angle);
  return cost;
}
function baCameraCost(cameraIndex, tracks, poses, pose = poses[cameraIndex]) {
  let cost = 0;
  for (const track of tracks) {
    for (const obs of track.observations) {
      if (obs.frameIndex === cameraIndex) cost += baHuberCost(baObservation(pose, track.position, obs.bearing).angle);
    }
  }
  return cost;
}
function baGlobalCost(tracks, poses) {
  let cost = 0;
  for (const track of tracks) cost += baTrackCost(track, poses);
  return cost;
}

function baPruneTracks(tracks, poses) {
  const beforeObservations = tracks.reduce((sum, track) => sum + track.observations.length, 0);
  const pruned = [];
  for (const track of tracks) {
    const anglesDeg = track.observations.map((obs) => baObservation(poses[obs.frameIndex], track.position, obs.bearing).angle * 180 / Math.PI);
    const med = baMedian(anglesDeg), mad = baMad(anglesDeg, med);
    const robustSigma = Math.max(0.15, 1.4826 * mad);
    const threshold = baClamp(med + 2.5 * robustSigma, BA_PRUNE_MIN_DEG, BA_PRUNE_MAX_DEG);
    const kept = track.observations.filter((obs, index) => Number.isFinite(anglesDeg[index]) && anglesDeg[index] <= threshold);
    if (kept.length < BA_MIN_TRACK_LENGTH) continue;
    const frameSpan = kept[kept.length - 1].frameIndex - kept[0].frameIndex;
    if (frameSpan < 2) continue;
    const candidate = { ...track, observations: kept };
    const point = baTriangulateTrack(candidate, poses);
    if (!point) continue;
    candidate.position = point;
    const finalAngles = candidate.observations.map((obs) => baObservation(poses[obs.frameIndex], point, obs.bearing).angle * 180 / Math.PI);
    if (baMedian(finalAngles) > 4.0) continue;
    pruned.push(candidate);
  }
  const afterObservations = pruned.reduce((sum, track) => sum + track.observations.length, 0);
  return {
    tracks: pruned,
    removedObservations: Math.max(0, beforeObservations - afterObservations),
    removedRate: 1 - afterObservations / Math.max(1, beforeObservations),
  };
}

function baPerturbPose(pose, parameter, epsilon) {
  const next = {
    position: [...pose.position],
    cameraToWorld: [...pose.cameraToWorld],
    time: pose.time,
    valid: pose.valid,
  };
  if (parameter < 3) {
    const delta = [0, 0, 0];
    delta[parameter] = epsilon;
    next.cameraToWorld = baMul3(next.cameraToWorld, baExpSO3(delta));
  } else {
    next.position[parameter - 3] += epsilon;
  }
  return next;
}

function baAccumulateNormal(J, residual, weight, n, H, g) {
  const sw = Math.sqrt(Math.max(1e-8, weight));
  for (let r = 0; r < 3; r += 1) {
    const rr = residual[r] * sw;
    for (let c = 0; c < n; c += 1) {
      const jc = J[r][c] * sw;
      g[c] += jc * rr;
      for (let d = c; d < n; d += 1) H[c * n + d] += jc * J[r][d] * sw;
    }
  }
  for (let c = 0; c < n; c += 1) for (let d = 0; d < c; d += 1) H[c * n + d] = H[d * n + c];
}

function baBestPointProposal(track, poses, step) {
  const before = baTrackCost(track, poses);
  let best = null;
  for (const scale of [1, 0.5, 0.25, 0.125]) {
    const proposal = baAdd3(track.position, baScale3(step, scale));
    const after = baTrackCost(track, poses, proposal);
    if (Number.isFinite(after) && after + 1e-12 < before && (!best || after < best.cost)) best = { proposal, cost: after };
  }
  return best;
}

function baRefinePoint(track, poses, lambda) {
  const H = new Array(9).fill(0), g = [0, 0, 0], point = track.position;
  for (const obs of track.observations) {
    const pose = poses[obs.frameIndex], base = baObservation(pose, point, obs.bearing), J = [[], [], []];
    for (let p = 0; p < 3; p += 1) {
      const shifted = [...point]; shifted[p] += BA_POINT_EPS;
      const pert = baObservation(pose, shifted, obs.bearing).residual;
      for (let r = 0; r < 3; r += 1) J[r][p] = (pert[r] - base.residual[r]) / BA_POINT_EPS;
    }
    baAccumulateNormal(J, base.residual, baHuberWeight(base.angle), 3, H, g);
  }
  for (let i = 0; i < 3; i += 1) H[i * 3 + i] += lambda;
  const step = baSolveLinear(H, g.map((x) => -x), 3);
  if (!step) return false;
  const maxStep = Math.max(0.03, Math.min(0.30, baNorm3(point) * 0.05));
  const n = baNorm3(step), limited = n > maxStep ? baScale3(step, maxStep / n) : step;
  const best = baBestPointProposal(track, poses, limited);
  if (!best) return false;
  track.position = best.proposal;
  return true;
}

function baApplyCameraStep(pose, rot, trans, scale) {
  return {
    ...pose,
    cameraToWorld: baMul3(pose.cameraToWorld, baExpSO3(baScale3(rot, scale))),
    position: baAdd3(pose.position, baScale3(trans, scale)),
  };
}

function baRefineCamera(cameraIndex, tracks, poses, lambda, fixed) {
  if (fixed.has(cameraIndex)) return false;
  const relevant = [];
  for (const track of tracks) for (const obs of track.observations) if (obs.frameIndex === cameraIndex) relevant.push({ track, obs });
  if (relevant.length < 10) return false;

  const H = new Array(36).fill(0), g = new Array(6).fill(0), pose = poses[cameraIndex];
  for (const item of relevant) {
    const base = baObservation(pose, item.track.position, item.obs.bearing), J = [[], [], []];
    for (let p = 0; p < 6; p += 1) {
      const eps = p < 3 ? BA_ROT_EPS : BA_TRANS_EPS;
      const pertPose = baPerturbPose(pose, p, eps);
      const pert = baObservation(pertPose, item.track.position, item.obs.bearing).residual;
      for (let r = 0; r < 3; r += 1) J[r][p] = (pert[r] - base.residual[r]) / eps;
    }
    baAccumulateNormal(J, base.residual, baHuberWeight(base.angle), 6, H, g);
  }
  for (let i = 0; i < 6; i += 1) H[i * 6 + i] += lambda;
  const step = baSolveLinear(H, g.map((x) => -x), 6);
  if (!step) return false;

  let rot = step.slice(0, 3), trans = step.slice(3);
  const rn = baNorm3(rot), tn = baNorm3(trans);
  const maxRot = 0.9 * Math.PI / 180, maxTrans = 0.08;
  if (rn > maxRot) rot = baScale3(rot, maxRot / rn);
  if (tn > maxTrans) trans = baScale3(trans, maxTrans / tn);

  const before = baCameraCost(cameraIndex, tracks, poses);
  let best = null;
  for (const scale of [1, 0.5, 0.25, 0.125]) {
    const proposal = baApplyCameraStep(pose, rot, trans, scale);
    const after = baCameraCost(cameraIndex, tracks, poses, proposal);
    if (Number.isFinite(after) && after + 1e-12 < before && (!best || after < best.cost)) best = { proposal, cost: after };
  }
  if (!best) return false;
  poses[cameraIndex] = best.proposal;
  return true;
}

function baMetrics(tracks, poses) {
  const angles = [];
  for (const track of tracks) {
    for (const obs of track.observations) {
      const angle = baObservation(poses[obs.frameIndex], track.position, obs.bearing).angle * 180 / Math.PI;
      if (Number.isFinite(angle)) angles.push(angle);
    }
  }
  const usable = angles.filter((a) => a <= BA_OUTLIER_DEG);
  const rms = usable.length ? Math.sqrt(usable.reduce((s, a) => s + a * a, 0) / usable.length) : 0;
  return {
    count: angles.length,
    inlierCount: usable.length,
    medianDeg: baMedian(usable),
    rmsDeg: rms,
    outlierRate: 1 - usable.length / Math.max(1, angles.length),
    robustCost: baGlobalCost(tracks, poses),
  };
}

function baAnchorIndices(poses) {
  const fixed = new Set([0]);
  const origin = poses[0]?.position || [0, 0, 0];
  let anchor = 1;
  for (let i = 1; i < poses.length; i += 1) {
    if (baNorm3(baSub3(poses[i].position, origin)) > 0.2) { anchor = i; break; }
  }
  fixed.add(Math.min(anchor, Math.max(0, poses.length - 1)));
  return fixed;
}

function baStateIsAcceptable(previous, current) {
  if (!Number.isFinite(current.robustCost) || !Number.isFinite(current.medianDeg) || !Number.isFinite(current.rmsDeg)) return false;
  const costOk = current.robustCost <= previous.robustCost * (1 + BA_GLOBAL_COST_TOL);
  const medianOk = current.medianDeg <= previous.medianDeg * (1 + BA_METRIC_TOL) + 1e-4;
  const rmsOk = current.rmsDeg <= previous.rmsDeg * (1 + BA_METRIC_TOL) + 1e-4;
  return costOk && medianOk && rmsOk;
}

function baOptimize(rawResult) {
  const poses = baClonePoses(rawResult.geometry.cameraPoses);
  const rawTracks = baBuildTracks(rawResult.frames);
  let tracks = baInitializeTracks(rawTracks, poses);
  if (tracks.length < 8) {
    const metrics = baMetrics(tracks, poses);
    return { success: false, quality: 'hold', reason: '複数フレームで追跡できる3D点が不足しています。', poses, tracks, initial: metrics, final: metrics, iterations: 0, rolledBack: false, prunedRate: 0 };
  }

  const prune = baPruneTracks(tracks, poses);
  tracks = prune.tracks;
  if (tracks.length < 8) {
    const metrics = baMetrics(tracks, poses);
    return { success: false, quality: 'hold', reason: '外れ観測を除くと安定した複数視点トラックが不足しました。', poses, tracks, initial: metrics, final: metrics, iterations: 0, rolledBack: false, prunedRate: prune.removedRate };
  }

  const fixed = baAnchorIndices(poses);
  const initial = baMetrics(tracks, poses);
  const initialPoses = baClonePoses(poses);
  const initialTracks = baCloneTracks(tracks);
  let bestPoses = baClonePoses(poses);
  let bestTracks = baCloneTracks(tracks);
  let bestMetrics = { ...initial };
  let lambda = 4e-3;
  let iterations = 0;
  let rejectedIterations = 0;

  for (let iter = 0; iter < BA_MAX_ITERATIONS; iter += 1) {
    const beforePoses = baClonePoses(poses);
    const beforeTracks = baCloneTracks(tracks);
    const previous = baMetrics(tracks, poses);
    let acceptedBlocks = 0;

    for (const track of tracks) if (baRefinePoint(track, poses, lambda)) acceptedBlocks += 1;
    for (let cameraIndex = 0; cameraIndex < poses.length; cameraIndex += 1) {
      if (baRefineCamera(cameraIndex, tracks, poses, lambda, fixed)) acceptedBlocks += 1;
    }

    const current = baMetrics(tracks, poses);
    iterations = iter + 1;

    if (!baStateIsAcceptable(previous, current)) {
      baCopyState(poses, tracks, beforePoses, beforeTracks);
      rejectedIterations += 1;
      lambda = Math.min(1.0, lambda * 4);
      if (rejectedIterations >= 3) break;
      continue;
    }

    rejectedIterations = 0;
    lambda = acceptedBlocks > 0 ? Math.max(5e-5, lambda * 0.7) : Math.min(1.0, lambda * 2.5);

    const improvedBest = current.robustCost < bestMetrics.robustCost - 1e-10 && current.medianDeg <= bestMetrics.medianDeg * 1.001 && current.rmsDeg <= bestMetrics.rmsDeg * 1.001;
    if (improvedBest) {
      bestMetrics = { ...current };
      bestPoses = baClonePoses(poses);
      bestTracks = baCloneTracks(tracks);
    }

    if (acceptedBlocks === 0 || current.medianDeg < 0.15) break;
  }

  const bestIsSafe = bestMetrics.medianDeg <= initial.medianDeg * 1.001 && bestMetrics.rmsDeg <= initial.rmsDeg * 1.001 && bestMetrics.robustCost <= initial.robustCost * 1.0001;
  let rolledBack = false;
  if (!bestIsSafe) {
    bestPoses = initialPoses;
    bestTracks = initialTracks;
    bestMetrics = { ...initial };
    rolledBack = true;
  }

  const medianImprovement = initial.medianDeg > 1e-6 ? (initial.medianDeg - bestMetrics.medianDeg) / initial.medianDeg : 0;
  const rmsImprovement = initial.rmsDeg > 1e-6 ? (initial.rmsDeg - bestMetrics.rmsDeg) / initial.rmsDeg : 0;
  const stableNotWorse = bestMetrics.medianDeg <= initial.medianDeg * 1.001 && bestMetrics.rmsDeg <= initial.rmsDeg * 1.001;

  let quality = 'hold';
  if (
    stableNotWorse &&
    bestTracks.length >= 14 &&
    bestMetrics.inlierCount >= 45 &&
    bestMetrics.medianDeg <= 2.0 &&
    bestMetrics.rmsDeg <= 3.0 &&
    bestMetrics.outlierRate <= 0.32 &&
    (medianImprovement >= 0.02 || rmsImprovement >= 0.02 || bestMetrics.medianDeg <= 0.85)
  ) quality = 'candidate';

  if (
    stableNotWorse &&
    bestTracks.length >= 24 &&
    bestMetrics.inlierCount >= 80 &&
    bestMetrics.medianDeg <= 1.2 &&
    bestMetrics.rmsDeg <= 2.0 &&
    bestMetrics.outlierRate <= 0.20 &&
    (medianImprovement >= 0.08 || rmsImprovement >= 0.08 || bestMetrics.medianDeg <= 0.60)
  ) quality = 'good';

  let reason = '';
  if (quality === 'hold') {
    if (rolledBack) reason = '更新で誤差が悪化したため、安全のため最適化前の状態に戻しました。';
    else if (bestMetrics.outlierRate > 0.32) reason = '外れ観測が多いため、3DGS入力前に追加の対応点整理が必要です。';
    else if (medianImprovement <= 0 && rmsImprovement <= 0) reason = '全体最適化による誤差改善を確認できませんでした。';
    else reason = '誤差は一部改善しましたが、3DGS入力に使うにはまだ安定性が不足しています。';
  }

  return {
    success: quality !== 'hold',
    quality,
    poses: bestPoses,
    tracks: bestTracks,
    initial,
    final: bestMetrics,
    iterations,
    medianImprovement,
    rmsImprovement,
    improvement: medianImprovement,
    fixed: [...fixed],
    rolledBack,
    prunedRate: prune.removedRate,
    prunedObservations: prune.removedObservations,
  };
}

function baEnsurePanel() {
  let panel = document.querySelector('#ba-panel');
  if (panel) return panel;
  const sfmPanel = document.querySelector('#sfm-panel');
  if (!sfmPanel) return null;
  panel = document.createElement('section');
  panel.id = 'ba-panel';
  panel.className = 'ba-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="ba-heading"><div><p class="eyebrow">安定化した全体最適化</p><h3>悪化する更新を戻しながらカメラ姿勢と疎3D点を調整</h3></div><span class="ba-auto">自動設定</span></div>
    <p class="ba-description">3フレーム以上で追跡できるERP球面特徴から明らかな外れ観測を先に除き、透視投影を介さない360°bearingの角度誤差を小さくするように最適化します。ERP特徴が不足した場合のみ従来観測を使用します。各反復後に全体のロバスト誤差・中央値・RMSを確認し、悪化した更新は自動的に取り消します。</p>
    <div class="ba-stats"><div><span>最適化した区間</span><strong id="ba-count">—</strong></div><div><span>良好</span><strong id="ba-good">—</strong></div><div><span>複数視点トラック</span><strong id="ba-tracks">—</strong></div><div><span>観測点</span><strong id="ba-observations">—</strong></div></div>
    <div id="ba-list" class="ba-list"></div><div id="ba-message" class="message-box" hidden></div>
    <p class="ba-note">これはブラウザ向けの小規模・ロバストな球面Bundle Adjustmentです。絶対距離スケールは引き続き未確定です。改善しない場合は、結果を良く見せるために無理に更新せず、最適化前へ戻します。</p>`;
  sfmPanel.insertAdjacentElement('afterend', panel);
  return panel;
}

function baDrawPreview(canvas, poses, tracks) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(300, canvas.clientWidth || 520), height = 220;
  canvas.width = width * dpr; canvas.height = height * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#d7dde7'; ctx.strokeRect(.5, .5, width - 1, height - 1);
  const cameraPoints = poses.map((p) => p.position), cloud = tracks.map((t) => t.position), all = [...cameraPoints, ...cloud];
  if (!all.length) return;
  let minX = Math.min(...all.map((p) => p[0])), maxX = Math.max(...all.map((p) => p[0]));
  let minZ = Math.min(...all.map((p) => p[2])), maxZ = Math.max(...all.map((p) => p[2]));
  if (maxX - minX < 1e-4) { minX -= 1; maxX += 1; }
  if (maxZ - minZ < 1e-4) { minZ -= 1; maxZ += 1; }
  const pad = 20, scale = Math.min((width - 2 * pad) / (maxX - minX), (height - 2 * pad) / (maxZ - minZ));
  const xy = (p) => [pad + (p[0] - minX) * scale, height - pad - (p[2] - minZ) * scale];
  ctx.fillStyle = 'rgba(75,85,99,.30)';
  for (const p of cloud) { const [x, y] = xy(p); ctx.fillRect(x - 1, y - 1, 2, 2); }
  if (cameraPoints.length > 1) {
    ctx.strokeStyle = '#111827'; ctx.lineWidth = 2; ctx.beginPath();
    cameraPoints.forEach((p, i) => { const [x, y] = xy(p); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.stroke();
  }
  cameraPoints.forEach((p, i) => {
    const [x, y] = xy(p); ctx.beginPath(); ctx.arc(x, y, i === 0 || i === cameraPoints.length - 1 ? 4 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#16803c' : i === cameraPoints.length - 1 ? '#b45309' : '#111827'; ctx.fill();
  });
}

function baResultMessage(opt) {
  if (opt.quality === 'good') return '誤差を悪化させずに複数視点の整合性を改善できました。3DGS学習用データへ進める候補です。';
  if (opt.quality === 'candidate') return '誤差を悪化させずに最適化できました。3DGS入力前に長距離対応や再訪拘束を追加して軌跡を確認します。';
  return opt.reason || '複数視点での追跡または最適化後の誤差が十分に安定しませんでした。';
}

function baRender(results) {
  const panel = baEnsurePanel();
  if (!panel) return;
  panel.hidden = false;
  const good = results.filter((r) => r.optimization.quality === 'good');
  const usable = results.filter((r) => r.optimization.quality !== 'hold');
  const trackCount = results.reduce((s, r) => s + r.optimization.tracks.length, 0);
  const obsCount = results.reduce((s, r) => s + r.optimization.final.count, 0);
  panel.querySelector('#ba-count').textContent = `${results.length}区間`;
  panel.querySelector('#ba-good').textContent = good.length ? `${good.length}区間` : 'なし';
  panel.querySelector('#ba-tracks').textContent = trackCount.toLocaleString();
  panel.querySelector('#ba-observations').textContent = obsCount.toLocaleString();
  const list = panel.querySelector('#ba-list'); list.replaceChildren();

  for (const item of results) {
    const opt = item.optimization, card = document.createElement('article');
    card.className = `ba-card ${opt.quality}`;
    const label = opt.quality === 'good' ? '最適化良好' : opt.quality === 'candidate' ? '最適化候補' : '保留';
    const before = opt.initial, after = opt.final;
    card.innerHTML = `
      <div class="ba-card-head"><div><span>候補区間 ${item.source.segment.id}</span><h4>${item.source.segment.start.toFixed(1)}秒 〜 ${item.source.segment.end.toFixed(1)}秒</h4></div><span class="ba-badge ${opt.quality}">${label}</span></div>
      <div class="ba-metrics">
        <span>複数視点トラック <strong>${opt.tracks.length}</strong></span>
        <span>観測 <strong>${after.count}</strong></span>
        <span>反復 <strong>${opt.iterations}</strong></span>
        <span>角度誤差中央値 <strong>${before.medianDeg.toFixed(2)}° → ${after.medianDeg.toFixed(2)}°</strong></span>
        <span>RMS角度誤差 <strong>${before.rmsDeg.toFixed(2)}° → ${after.rmsDeg.toFixed(2)}°</strong></span>
        <span>最終外れ観測 <strong>${Math.round(after.outlierRate * 100)}%</strong></span>
        <span>事前除外観測 <strong>${Math.round((opt.prunedRate || 0) * 100)}%</strong></span>
        <span>安全ロールバック <strong>${opt.rolledBack ? '実施' : '不要'}</strong></span>
      </div>
      <canvas class="ba-preview"></canvas><p>${baResultMessage(opt)}</p>`;
    list.append(card);
    baDrawPreview(card.querySelector('canvas'), opt.poses, opt.tracks);
  }

  const message = panel.querySelector('#ba-message'); message.hidden = false;
  if (good.length) {
    message.className = 'message-box success';
    message.textContent = `${good.length}区間で、誤差を悪化させない条件を満たした全体最適化が成立しました。次は3DGS入力用データセットの整備へ進めます。`;
  } else if (usable.length) {
    message.className = 'message-box warning';
    message.textContent = '安定化後に最適化候補として残る区間があります。次に再訪位置や長距離対応を追加し、3DGS入力前の軌跡をさらに確認します。';
  } else {
    message.className = 'message-box warning';
    message.textContent = '最適化で明確な改善を確認できなかったため、悪化する更新は採用していません。次工程へ無理に進まず、対応点または軌跡の安定化を優先します。';
  }
  window.__360gsBundleResult = { results, good, usable, trackCount, obsCount };
  window.dispatchEvent(new CustomEvent('360gs:ba-ready', { detail: window.__360gsBundleResult }));
}

async function baRun(detail) {
  if (baRunning || !detail?.usable?.length) return;
  const signature = `${baSourceVideo?.currentSrc || baSourceVideo?.src}|${detail.usable.map((r) => `${r.segment.id}-${r.frames.length}-${r.pointCount}`).join('|')}`;
  if (signature === baLastSignature) return;
  baLastSignature = signature; baRunning = true;
  const generation = ++baGeneration, panel = baEnsurePanel();
  if (panel) panel.hidden = false;
  try {
    const results = [];
    for (let i = 0; i < detail.usable.length; i += 1) {
      if (generation !== baGeneration) return;
      const source = detail.usable[i];
      if (baProgressText) baProgressText.textContent = `候補区間 ${i + 1}/${detail.usable.length} の安定化した全体最適化を行っています`;
      const optimization = baOptimize(source);
      results.push({ source, optimization });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (generation !== baGeneration) return;
    baRender(results);
    if (baProgressText) baProgressText.textContent = '誤差悪化を防ぐ全体最適化まで完了しました';
  } catch (error) {
    const panelNow = baEnsurePanel(), message = panelNow?.querySelector('#ba-message');
    if (message) {
      message.hidden = false; message.className = 'message-box warning';
      message.textContent = error?.message || '全体最適化を完了できませんでした。';
    }
    if (baProgressText) baProgressText.textContent = '全体最適化を完了できませんでした';
  } finally {
    if (generation === baGeneration) baRunning = false;
  }
}

function baReset() {
  baGeneration += 1; baRunning = false; baLastSignature = '';
  window.__360gsBundleResult = null;
  const panel = document.querySelector('#ba-panel'); if (panel) panel.hidden = true;
}

document.querySelectorAll('.version').forEach((node) => { node.textContent = 'Prototype v0.2h'; });
const heroEyebrow = document.querySelector('.video-hero .eyebrow');
if (heroEyebrow) heroEyebrow.textContent = 'Step 7 / 安定化した全体最適化';
const heroTitle = document.querySelector('.video-hero h1');
if (heroTitle) heroTitle.textContent = '誤差が悪化する更新を自動で戻しながら、3D構造を整えます。';

window.addEventListener('360gs:sfm-ready', (event) => window.setTimeout(() => baRun(event.detail), 150));
baSourceVideo?.addEventListener('loadedmetadata', baReset);
if (window.__360gsLocalSfmResult?.usable?.length) window.setTimeout(() => baRun(window.__360gsLocalSfmResult), 150);
