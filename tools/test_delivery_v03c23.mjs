import assert from 'node:assert/strict';
import { encodeSpzV4, encodeViewState, decodeViewState } from '../delivery.js';
import createSpzModule from '../vendor/spz/dist/spz.js';

const n = 2;
const degree = 1;
const nc = 4;
const transforms = new Float32Array(n * 10);
const shCoeffs = new Float32Array(n * nc * 3);
const rawOpacities = new Float32Array([1.2, -0.3]);

// Brush layout: xyz, qw qx qy qz, log scales.
transforms.set([1.25, -0.5, 2.75, 1, 0, 0, 0, -2.0, -2.2, -2.4], 0);
transforms.set([-0.75, 1.1, 4.5, 0.9238795, 0, 0.3826834, 0, -1.7, -1.9, -2.1], 10);
for (let i = 0; i < shCoeffs.length; i++) shCoeffs[i] = (i % 9 - 4) * 0.01;

const source = { count: n, degree, transforms, shCoeffs, rawOpacities };
const blob = await encodeSpzV4(source, { bounds: { radius: 5 } });
const bytes = new Uint8Array(await blob.arrayBuffer());
assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'NGSP');
assert.equal(new DataView(bytes.buffer).getUint32(4, true), 4);

const mod = await createSpzModule();
const decoded = mod.loadSpzFromBuffer(bytes, { to: mod.CoordinateSystem.RDF });
assert.equal(decoded.numPoints, n);
assert.equal(decoded.shDegree, degree);
for (let i = 0; i < n * 3; i++) {
  assert.ok(Math.abs(decoded.positions[i] - transforms[Math.floor(i / 3) * 10 + (i % 3)]) < 0.002,
    `position ${i}: ${decoded.positions[i]}`);
}
assert.equal(decoded.rotations.length, n * 4);
assert.equal(decoded.scales.length, n * 3);
assert.equal(decoded.colors.length, n * 3);
assert.equal(decoded.sh.length, n * 9);

const view = { mode: 'orbit', yaw: 0.73456789, pitch: -0.21, distanceRatio: 2.75, fov: 55 };
const hash = `#${encodeViewState(view)}`;
const restored = decodeViewState(hash);
assert.equal(restored.mode, 'orbit');
assert.ok(Math.abs(restored.yaw - 0.734568) < 1e-6);
assert.ok(Math.abs(restored.pitch + 0.21) < 1e-6);
assert.equal(restored.distanceRatio, 2.75);

console.log(`c23 delivery smoke test passed: ${bytes.byteLength} byte SPZ v4, viewpoint round trip OK`);
