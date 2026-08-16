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

- Version: 2.21.2 in the current 3DGS result viewer
- License: MIT
- Project: https://playcanvas.com/

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
- Purpose in v0.3c19: optional local WebGPU depth estimation when measured spherical geometry remains too sparse.
- Loaded as an ES module from jsDelivr only when the guarded depth-prior stage is needed.

## Depth Anything V2 Small ONNX

- Browser model: `onnx-community/depth-anything-v2-small-ONNX`
- Base model: `depth-anything/Depth-Anything-V2-Small`
- License: Apache-2.0
- Purpose in v0.3c19: optional relative-depth proposals. Relative depth is never accepted directly; it must first be calibrated by triangulated/BA 3D anchors and pass a second-camera consistency check.
- The quantized model is downloaded from Hugging Face when required and inference runs locally in the browser. User video frames are not uploaded by 360GS for this inference.

The 3DGS test page can optionally load the official PlayCanvas `toy-cat.sog` sample from the PlayCanvas developer site. User-selected local files and the browser 3DGS training dataset are not uploaded by the current 360GS prototype.
