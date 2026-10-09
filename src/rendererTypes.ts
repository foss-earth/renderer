export type RendererMode = "webgpu" | "webgl2" | "webgl";

export interface RendererDiagnostics {
  navigatorGpuPresent: boolean;
  isSupportedAsyncResult: boolean | null;
  isSecureContext: boolean;
  fromPersistedPreference?: boolean;
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
