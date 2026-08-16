// 360GS v0.3c16
// Clean room spherical feature utilities for equirectangular panoramas.
// This module implements standard spherical geometry directly from the ERP
// parameterization and does not copy third party rasterizer code.

const TAU = Math.PI * 2;

export function sphericalClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalize3(v) {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(n) || n < 1e-12) return [0, 0, 1];
  return [v[0] / n, v[1] / n, v[2] / n];
}

export function sphericalBearingFromPixel(x, y, width, height) {
  const longitude = TAU * ((x + 0.5) / width - 0.5);
  const latitude = Math.PI * (0.5 - (y + 0.5) / height);
  const cosLat = Math.cos(latitude);
  return [
    Math.sin(longitude) * cosLat,
    Math.sin(latitude),
    Math.cos(longitude) * cosLat,
  ];
}

export function sphericalPixelFromBearing(bearing, width, height) {
  const d = normalize3(bearing);
  const longitude = Math.atan2(d[0], d[2]);
  const latitude = Math.asin(sphericalClamp(d[1], -1, 1));
  let x = (longitude / TAU + 0.5) * width - 0.5;
  x = ((x % width) + width) % width;
  const y = sphericalClamp((0.5 - latitude / Math.PI) * height - 0.5, 0, height - 1);
  return { x, y, longitude, latitude };
}

export function sphericalDirectionLabel(bearing) {
  const d = normalize3(bearing);
  const longitude = Math.atan2(d[0], d[2]) * 180 / Math.PI;
  if (longitude >= -45 && longitude < 45) return 'front';
  if (longitude >= 45 && longitude < 135) return 'right';
  if (longitude >= -135 && longitude < -45) return 'left';
  return 'back';
}

function wrapX(x, width) {
  return ((x % width) + width) % width;
}

function sampleGray(gray, width, height, x, y) {
  const yy = sphericalClamp(y, 0, height - 1);
  const y0 = Math.floor(yy);
  const y1 = Math.min(height - 1, y0 + 1);
  const fy = yy - y0;
  const xx = wrapX(x, width);
  const x0 = Math.floor(xx);
  const x1 = (x0 + 1) % width;
  const fx = xx - x0;
  const a = gray[y0 * width + x0];
  const b = gray[y0 * width + x1];
  const c = gray[y1 * width + x0];
  const d = gray[y1 * width + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

function tangentBasis(bearing) {
  const d = normalize3(bearing);
  const longitude = Math.atan2(d[0], d[2]);
  const latitude = Math.asin(sphericalClamp(d[1], -1, 1));
  const eLon = [Math.cos(longitude), 0, -Math.sin(longitude)];
  const eLat = [
    -Math.sin(longitude) * Math.sin(latitude),
    Math.cos(latitude),
    -Math.cos(longitude) * Math.sin(latitude),
  ];
  return { d, eLon, eLat, longitude, latitude };
}

function tangentSampleDirection(basis, lonOffset, latOffset) {
  const ax = Math.tan(lonOffset);
  const ay = Math.tan(latOffset);
  return normalize3([
    basis.d[0] + ax * basis.eLon[0] + ay * basis.eLat[0],
    basis.d[1] + ax * basis.eLon[1] + ay * basis.eLat[1],
    basis.d[2] + ax * basis.eLon[2] + ay * basis.eLat[2],
  ]);
}

function tangentDescriptor(gray, width, height, bearing, options) {
  const basis = tangentBasis(bearing);
  const offsets = options.descriptorOffsets || [-2, -1, 0, 1, 2];
  const angularStep = options.angularStep || (TAU / width) * 2.2;
  const raw = new Float32Array(offsets.length * offsets.length);
  let index = 0;
  let mean = 0;
  for (const oy of offsets) {
    for (const ox of offsets) {
      const sampleBearing = tangentSampleDirection(basis, ox * angularStep, oy * angularStep);
      const pixel = sphericalPixelFromBearing(sampleBearing, width, height);
      const value = sampleGray(gray, width, height, pixel.x, pixel.y);
      raw[index++] = value;
      mean += value;
    }
  }
  mean /= raw.length;
  let variance = 0;
  for (const value of raw) variance += (value - mean) ** 2;
  const std = Math.sqrt(variance / raw.length);
  if (!Number.isFinite(std) || std < (options.minStd ?? 6)) return null;
  for (let i = 0; i < raw.length; i += 1) raw[i] = (raw[i] - mean) / std;
  return { descriptor: raw, std, latitude: basis.latitude };
}

function cornerResponse(gray, width, height, x, y) {
  let a = 0;
  let b = 0;
  let c = 0;
  for (let dy = -2; dy <= 2; dy += 1) {
    const yy = sphericalClamp(y + dy, 1, height - 2);
    for (let dx = -2; dx <= 2; dx += 1) {
      const xx = x + dx;
      const gx = sampleGray(gray, width, height, xx + 1, yy) - sampleGray(gray, width, height, xx - 1, yy);
      const gy = sampleGray(gray, width, height, xx, yy + 1) - sampleGray(gray, width, height, xx, yy - 1);
      a += gx * gx;
      b += gy * gy;
      c += gx * gy;
    }
  }
  const trace = a + b;
  return (trace - Math.sqrt(Math.max(0, (a - b) ** 2 + 4 * c * c))) / 2;
}

function angularSeparated(candidateBearing, selected, minAngleRad) {
  if (!selected.length) return true;
  const cosLimit = Math.cos(minAngleRad);
  for (const feature of selected) {
    const d = feature.bearing;
    const dot = candidateBearing[0] * d[0] + candidateBearing[1] * d[1] + candidateBearing[2] * d[2];
    if (dot > cosLimit) return false;
  }
  return true;
}

export function sphericalDetectFeatures(gray, width, height, options = {}) {
  const maxFeatures = options.maxFeatures ?? 320;
  const scanStep = options.scanStep ?? Math.max(2, Math.round(width / 260));
  const minResponse = options.minResponse ?? 900;
  const maxLatitudeDeg = options.maxLatitudeDeg ?? 80;
  const maxLatitude = maxLatitudeDeg * Math.PI / 180;
  const minAngleDeg = options.minAngleDeg ?? 1.7;
  const minAngleRad = minAngleDeg * Math.PI / 180;
  const yMargin = Math.max(4, Math.ceil(height * (0.5 - maxLatitude / Math.PI)));
  const candidates = [];

  for (let y = yMargin; y < height - yMargin; y += scanStep) {
    const latitude = Math.PI * (0.5 - (y + 0.5) / height);
    const areaWeight = Math.max(0.18, Math.cos(latitude));
    for (let x = 0; x < width; x += scanStep) {
      const rawResponse = cornerResponse(gray, width, height, x, y);
      const response = rawResponse * Math.sqrt(areaWeight);
      if (response >= minResponse) candidates.push({ x, y, response, areaWeight });
    }
  }

  candidates.sort((a, b) => b.response - a.response);
  const features = [];
  const descriptorOptions = {
    minStd: options.minStd ?? 6,
    angularStep: options.angularStep,
    descriptorOffsets: options.descriptorOffsets,
  };

  for (const candidate of candidates) {
    const bearing = sphericalBearingFromPixel(candidate.x, candidate.y, width, height);
    if (!angularSeparated(bearing, features, minAngleRad)) continue;
    const desc = tangentDescriptor(gray, width, height, bearing, descriptorOptions);
    if (!desc) continue;
    const cornerScore = sphericalClamp(candidate.response / (candidate.response + 2200), 0, 1);
    const contrastScore = sphericalClamp((desc.std - 4) / 30, 0, 1);
    const latitudeWeight = Math.max(0.25, Math.cos(desc.latitude));
    const baseConfidence = sphericalClamp((0.56 * cornerScore + 0.44 * contrastScore) * (0.78 + 0.22 * latitudeWeight), 0, 1);
    features.push({
      x: candidate.x,
      y: candidate.y,
      bearing,
      descriptor: desc.descriptor,
      response: candidate.response,
      std: desc.std,
      latitude: desc.latitude,
      baseConfidence,
      trackingConfidence: baseConfidence,
      dir: sphericalDirectionLabel(bearing),
      spherical: true,
    });
    if (features.length >= maxFeatures) break;
  }
  return features;
}

function descriptorDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function nearestTwo(feature, targets) {
  let bestIndex = -1;
  let best = Infinity;
  let second = Infinity;
  for (let i = 0; i < targets.length; i += 1) {
    const distance = descriptorDistance(feature.descriptor, targets[i].descriptor);
    if (distance < best) {
      second = best;
      best = distance;
      bestIndex = i;
    } else if (distance < second) {
      second = distance;
    }
  }
  return { bestIndex, best, second };
}

export function sphericalMatchFeatures(left, right, options = {}) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length < 8 || right.length < 8) return [];
  const ratio = options.ratio ?? 0.78;
  const reverseRatio = options.reverseRatio ?? 0.82;
  const minConfidence = options.minConfidence ?? 0.12;
  const forward = left.map((feature) => nearestTwo(feature, right));
  const reverse = right.map((feature) => nearestTwo(feature, left));
  const matches = [];

  forward.forEach((candidate, leftIndex) => {
    if (candidate.bestIndex < 0 || !Number.isFinite(candidate.second) || candidate.second <= 1e-9 || candidate.best > candidate.second * ratio) return;
    const back = reverse[candidate.bestIndex];
    if (!back || back.bestIndex !== leftIndex || !Number.isFinite(back.second) || back.second <= 1e-9 || back.best > back.second * reverseRatio) return;
    const lf = left[leftIndex];
    const rf = right[candidate.bestIndex];
    const ratioScore = sphericalClamp(1 - candidate.best / Math.max(candidate.second, 1e-9), 0, 1);
    const confidence = sphericalClamp(0.52 * ((lf.baseConfidence || 0) + (rf.baseConfidence || 0)) / 2 + 0.48 * ratioScore, 0, 1);
    if (confidence < minConfidence) return;
    matches.push({
      left: lf,
      right: rf,
      distance: candidate.best,
      confidence,
      quality: candidate.best / Math.max(candidate.second, 1e-9),
      source: 'erp',
    });
  });

  return matches.sort((a, b) => b.confidence - a.confidence || a.distance - b.distance);
}
