export type RendererMode = "webgpu" | "webgl2" | "webgl";

export interface RendererDiagnostics {
  navigatorGpuPresent: boolean;
  isSupportedAsyncResult: boolean | null;
  isSecureContext: boolean;
  fromPersistedPreference?: boolean;
  /** WebGL was chosen without trying WebGPU, by a fallback saved at this time (milliseconds since 1970). */
  fallbackSavedAt?: number;
  /** WebGL was chosen without trying WebGPU, because the device needs it, such as a VR headset. */
  webGlRequired?: boolean;
  /** WebGPU started without the presentation probe; its first frames on the page's canvas are watched instead. */
  probeSkipped?: boolean;
}

/** Pure selection data; a backend adapter supplies the concrete engine type. */
export interface RendererSelection<T = unknown> {
  requested: RendererMode | "auto";
  mode: RendererMode;
  engine: T;
  fallbackReason?: string;
  diagnostics?: RendererDiagnostics;
  antialias?: boolean;
  devicePixels?: boolean;
}

export interface RendererModeOptions {
  force?: RendererMode | null;
  antialias?: boolean;
}
