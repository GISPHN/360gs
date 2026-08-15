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

- Version: 2.21.4
- License: MIT
- Project: https://playcanvas.com/

## Brush

- Source: ArthurBrussee/brush
- Pinned source commit for the bundled browser runtime: `3da02ecfe91aae9c011a8c8c482d82860b88eb1f`
- License: Apache-2.0
- Purpose: WebGPU based 3D Gaussian Splatting training in the browser.
- The generated JavaScript/WebAssembly runtime is built by `.github/workflows/build-brush-js.yml` and stored under `vendor/brush-js/`.

The 3DGS test page can optionally load the official PlayCanvas `toy-cat.sog` sample from the PlayCanvas developer site. User-selected local files and the browser 3DGS training dataset are not uploaded by Prototype v0.3b.
