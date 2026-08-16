# 360GS v0.3c9 field fix

The v0.3c8 browser field test reached approximately iteration 1,580 of 7,200 with 30,000 Gaussians, then entered the first Brush refinement boundary and exceeded the four minute GPU step safety timeout.

v0.3c9 replaces the WebAssembly full Brush refine path with bounded GPU-only Gaussian growth. The browser path does not perform training-time pruning, GPU-to-CPU argwhere/statistics readback, or bounds recomputation at the growth boundary. A deterministic subset of the geometry-backed initial seed region is split on the GPU. Growth remains constrained by the device Gaussian cap, growth fraction, and configured growth stop iteration.

The grouped source-position holdout, BA/SfM-informed hybrid initialization, long optimization horizon, SH degree 0 comparison condition, and adaptive held-out convergence stopping are retained.
