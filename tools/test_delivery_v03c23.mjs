import assert from 'node:assert/strict';
import { encodeSpzV4, encodePlyToSpzV4, encodeViewState, decodeViewState } from '../delivery.js';
import createSpzModule from '../vendor/spz/dist/spz.js';

const n = 2;
const degree = 1;
const nc = 4;
const shDim = nc - 1;
const transforms = new Float32Array(n * 10);
const shCoeffs = new Float32Array(n * nc * 3);
const rawOpacities = new Float32Array([1.2, -0.3]);

// Brush layout: xyz, qw qx qy qz, log scales.
transforms.set([1.25, -0.5, 2.75, 1, 0, 0, 0, -2.0, -2.2, -2.4], 0);
transforms.set([-0.75, 1.1, 4.5, 0.9238795, 0, 0.3826834, 0, -1.7, -1.9, -2.1], 10);
for (let i = 0; i < shCoeffs.length; i++) shCoeffs[i] = (i % 9 - 4) * 0.01;

const source = { count: n, degree, transforms, shCoeffs, rawOpacities };
const mod = await createSpzModule();

function validateSpz(bytes, label) {
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'NGSP', `${label}: NGSP magic`);
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true), 4, `${label}: v4 header`);
  const decoded = mod.loadSpzFromBuffer(bytes, { to: mod.CoordinateSystem.RDF });
  assert.equal(decoded.numPoints, n, `${label}: point count`);
  assert.equal(decoded.shDegree, degree, `${label}: SH degree`);
  for (let i = 0; i < n * 3; i++) {
    const expected = transforms[Math.floor(i / 3) * 10 + (i % 3)];
    assert.ok(Math.abs(decoded.positions[i] - expected) < 0.002, `${label}: position ${i}: ${decoded.positions[i]} vs ${expected}`);
  }
  assert.equal(decoded.rotations.length, n * 4, `${label}: rotations`);
  assert.equal(decoded.scales.length, n * 3, `${label}: scales`);
  assert.equal(decoded.colors.length, n * 3, `${label}: colors`);
  assert.equal(decoded.sh.length, n * shDim * 3, `${label}: SH array`);
  return decoded;
}

// Direct Brush-array path.
const directBlob = await encodeSpzV4(source, { bounds: { radius: 5 } });
const directBytes = new Uint8Array(await directBlob.arrayBuffer());
const directDecoded = validateSpz(directBytes, 'direct');

// Production path: reproduce the exact binary little-endian PLY layout emitted by training.js,
// then parse that PLY and encode it to SPZ v4.
function buildTrainingPly() {
  const props = [
    'property float x', 'property float y', 'property float z',
    'property float nx', 'property float ny', 'property float nz',
    'property float f_dc_0', 'property float f_dc_1', 'property float f_dc_2'
  ];
  for (let i = 0; i < shDim * 3; i++) props.push(`property float f_rest_${i}`);
  props.push(
    'property float opacity',
    'property float scale_0', 'property float scale_1', 'property float scale_2',
    'property float rot_0', 'property float rot_1', 'property float rot_2', 'property float rot_3'
  );
  const header = new TextEncoder().encode(
    `ply\nformat binary_little_endian 1.0\ncomment c23 production-path test\nelement vertex ${n}\n${props.join('\n')}\nend_header\n`
  );
  const floatsPerRow = 3 + 3 + 3 + shDim * 3 + 1 + 3 + 4;
  const out = new ArrayBuffer(header.length + n * floatsPerRow * 4);
  new Uint8Array(out, 0, header.length).set(header);
  const view = new DataView(out);
  let offset = header.length;
  const write = value => { view.setFloat32(offset, Number(value), true); offset += 4; };

  for (let i = 0; i < n; i++) {
    const z = i * 10;
    const s = i * nc * 3;
    write(transforms[z]); write(transforms[z + 1]); write(transforms[z + 2]);
    write(0); write(0); write(0);
    write(shCoeffs[s]); write(shCoeffs[s + 1]); write(shCoeffs[s + 2]);
    // training.js writes f_rest channel-major: all coefficients for R, then G, then B.
    for (let ch = 0; ch < 3; ch++) {
      for (let c = 1; c < nc; c++) write(shCoeffs[s + c * 3 + ch]);
    }
    write(rawOpacities[i]);
    write(transforms[z + 7]); write(transforms[z + 8]); write(transforms[z + 9]);
    const qw = transforms[z + 3], qx = transforms[z + 4], qy = transforms[z + 5], qz = transforms[z + 6];
    const qn = Math.hypot(qw, qx, qy, qz) || 1;
    write(qw / qn); write(qx / qn); write(qy / qn); write(qz / qn);
  }
  return new Blob([out], { type: 'application/octet-stream' });
}

const plyBlob = buildTrainingPly();
const plySpzBlob = await encodePlyToSpzV4(plyBlob, { bounds: { radius: 5 } });
const plyBytes = new Uint8Array(await plySpzBlob.arrayBuffer());
const plyDecoded = validateSpz(plyBytes, 'PLY->SPZ');

// The production PLY route should preserve the same Gaussian attributes within SPZ quantization.
for (let i = 0; i < n * 3; i++) {
  assert.ok(Math.abs(plyDecoded.colors[i] - directDecoded.colors[i]) < 0.02, `DC ${i}`);
  assert.ok(Math.abs(plyDecoded.scales[i] - directDecoded.scales[i]) < 0.02, `scale ${i}`);
}
for (let i = 0; i < n * shDim * 3; i++) {
  assert.ok(Math.abs(plyDecoded.sh[i] - directDecoded.sh[i]) < 0.04, `SH ${i}`);
}
for (let i = 0; i < n; i++) {
  const a = plyDecoded.rotations.subarray(i * 4, i * 4 + 4);
  const b = directDecoded.rotations.subarray(i * 4, i * 4 + 4);
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  assert.ok(dot > 0.995, `quaternion ${i}: dot=${dot}`);
}

const view = { mode: 'orbit', yaw: 0.73456789, pitch: -0.21, distanceRatio: 2.75, fov: 55 };
const hash = `#${encodeViewState(view)}`;
const restored = decodeViewState(hash);
assert.equal(restored.mode, 'orbit');
assert.ok(Math.abs(restored.yaw - 0.734568) < 1e-6);
assert.ok(Math.abs(restored.pitch + 0.21) < 1e-6);
assert.equal(restored.distanceRatio, 2.75);

console.log(`c23 delivery smoke test passed: direct ${directBytes.byteLength} B, PLY->SPZ ${plyBytes.byteLength} B, viewpoint round trip OK`);
