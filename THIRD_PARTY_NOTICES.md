# Third Party Notices

360GS uses the following open source libraries.

## Photo Sphere Viewer

- Version: 5.15.0
- License: MIT
- Project: https://photo-sphere-viewer.js.org/

## Three.js

- Version: 0.179.1
- License: MIT
- Project: https://threejs.org/

## PlayCanvas Engine

- Version: 2.21.2
- License: MIT
- Project: https://playcanvas.com/
- Purpose: 3DGS viewing. In v0.3c23 the engine runtime is also vendored under `vendor/playcanvas/` and the standalone viewer explicitly selects WebGL 2.

## PlayCanvas SPZ parser and ZSTD decoder

- PlayCanvas parser source: 2.21.2, MIT
- ZSTD decoder provenance: zstddeclib / zstddec, BSD-3-Clause / MIT as documented by PlayCanvas
- Purpose in v0.3c23: SPZ v4 loading in the standalone WebGL 2 viewer.
- Runtime assets are stored under `vendor/playcanvas-spz/`.

## Niantic SPZ / Adobe browser bindings

- Browser package: `@adobe/spz` 0.2.2
- Upstream: nianticlabs/spz
- Package license: ISC; upstream and Emscripten binding source include MIT notices
- Purpose in v0.3c23: local browser conversion of generated 3DGS PLY data to SPZ file-format version 4.
- The encoder runs in the browser; 360GS does not upload a user model to an external conversion service.
- Runtime files are stored under `vendor/spz/`.

## Brush

- Source: ArthurBrussee/brush
- Compatibility source commit for the current bundled browser runtime: `3b80985709e2ec04fd6c8622a40e36473647a8e0`
- License: Apache-2.0
- Purpose: WebGPU based 3D Gaussian Splatting training in the browser.
- The generated JavaScript/WebAssembly runtime is stored under `vendor/brush-js/`.

## Transformers.js

- Version: 4.2.0
- Source: huggingface/transformers.js
- License: Apache-2.0
- Purpose in v0.3c19 and later: optional local WebGPU depth estimation when measured spherical geometry remains too sparse.
- Loaded as an ES module from jsDelivr only when the guarded depth-prior stage is needed.

## Depth Anything V2 Small ONNX

- Browser model: `onnx-community/depth-anything-v2-small-ONNX`
- Base model: `depth-anything/Depth-Anything-V2-Small`
- License: Apache-2.0
- Purpose: optional relative-depth proposals. Relative depth is never accepted directly; it must first be calibrated by triangulated/BA 3D anchors and pass a second-camera consistency check.
- The quantized model is downloaded from Hugging Face when required and inference runs locally in the browser. User video frames are not uploaded by 360GS for this inference.

## Gauzilla

- Project: BladeTransformerLLC/gauzilla
- License: MIT
- Usage in v0.3c23: architectural reference for browser-first 3DGS delivery, WebGL compatibility, compact splat handling and explicit camera controls.
- No Gauzilla source code is copied into 360GS.

The 3DGS test page can optionally load the official PlayCanvas `toy-cat.sog` sample from the PlayCanvas developer site. User-selected local files and the browser 3DGS training dataset are not uploaded by the current 360GS prototype.
