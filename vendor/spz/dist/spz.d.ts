/*
MIT License

Copyright (c) 2025 Adobe Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

export enum CoordinateSystem {
  UNSPECIFIED,
  LDB,
  RDB,
  LUB,
  RUB,
  LDF,
  RDF,
  LUF,
  RUF,
  LBD,
  RBD,
  LBU,
  RBU,
  LFD,
  RFD,
  LFU,
  RFU,
}

export enum SpzExtensionType {
  SPZ_ADOBE_safe_orbit_camera = 0xADBE0002,
  SPZ_ADOBE_coordinate_system = 0xADBE0003,
}

export class SpzExtensionBase {
  readonly extensionType: SpzExtensionType;
}

export class SpzExtensionSafeOrbitCameraAdobe extends SpzExtensionBase {
  safeOrbitElevationMin: number;
  safeOrbitElevationMax: number;
  safeOrbitRadiusMin: number;
  constructor();
  static type(): SpzExtensionType;
}

export class SpzExtensionCoordinateSystemAdobe extends SpzExtensionBase {
  coordinateSystem: CoordinateSystem;
  constructor();
  static type(): SpzExtensionType;
}

/** Returns true if the PLY extra element name is handled by an extension. */
export function isKnownPlyExtensionElement(elementName: string): boolean;


export interface PackOptions {
  version: number;
  from: CoordinateSystem;
  sh1Bits: number;
  shRestBits: number;
}

export interface UnpackOptions {
  to: CoordinateSystem;
}

export class GaussianCloud {
  numPoints: number;
  shDegree: number;
  antialiased: boolean;
  extensions: SpzExtensionBase[];
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  alphas: Float32Array;
  colors: Float32Array;
  sh: Float32Array;
}

// Wrappers for the module interface
export interface SpzModule {
  // Enum
  CoordinateSystem: typeof CoordinateSystem;
  SpzExtensionType: typeof SpzExtensionType;

  // Extension classes
  SpzExtensionBase: typeof SpzExtensionBase;
  SpzExtensionSafeOrbitCameraAdobe: typeof SpzExtensionSafeOrbitCameraAdobe;
  SpzExtensionCoordinateSystemAdobe: typeof SpzExtensionCoordinateSystemAdobe;

  /** Returns true if the PLY extra element name is handled by an extension. */
  isKnownPlyExtensionElement: (elementName: string) => boolean;

  // Loaders / Savers
  loadSpzFromBuffer(data: Uint8Array, options: UnpackOptions): GaussianCloud;
  saveSpzToBuffer(cloud: GaussianCloud, options: PackOptions): Uint8Array;

  /** Returns true if the build has extension support enabled, false otherwise. */
  SpzHasExtensionSupport(): boolean;

  LATEST_SPZ_HEADER_VERSION: number;
}

export default function createSpzModule(overrides?: any): Promise<SpzModule>;

