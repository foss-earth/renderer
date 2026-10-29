/**
 * When analytical upscaling runs, and the RCAS sharpness weight.
 * The passes themselves live under the Babylon entry.
 */

export const SPATIAL_UPSCALING_MODES = ["off", "easu", "easu-rcas"] as const;
export type SpatialUpscalingMode = (typeof SPATIAL_UPSCALING_MODES)[number];

export interface SpatialUpscalingRequest {
  mode: SpatialUpscalingMode | string;
  /** 0 is the gentlest RCAS lobe, 1 the strongest. */
  sharpness: number;
  /** Effective internal scale. Passes run only below 0.999. */
  effectiveRenderScale: number;
  /** WebGL1 cannot sample the reconstruction. Other values, including omitted, can. */
  backend?: string;
}

export interface SpatialUpscalingState {
  active: boolean;
  easu: boolean;
  rcas: boolean;
  /** Linear RCAS lobe weight, 2^{-stops}. */
  attenuation: number;
  /** A reason to show under the control, or null when there is nothing to explain. */
  unavailableReason: string | null;
}

/** WebGL1 has no render-target path for these passes. */
export const SPATIAL_UPSCALING_WEBGL1_NOTE = "Unavailable on WebGL1: spatial upscaling requires WebGPU or WebGL2.";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Maps a 0..1 sharpness onto FSR's RCAS attenuation.
 * Stops run from 2 at sharpness 0 to 0 at sharpness 1, and the weight is 2^{-stops}.
 */
export function rcasSharpnessToAttenuation(sharpness: number): number {
  const stops = 2 * (1 - clamp01(sharpness));
  return 2 ** (-stops);
}

function isMode(mode: string): mode is SpatialUpscalingMode {
  return mode === "off" || mode === "easu" || mode === "easu-rcas";
}

/** EASU and RCAS run only while a supported backend is drawing below native. */
export function resolveSpatialUpscalingState(request: SpatialUpscalingRequest): SpatialUpscalingState {
  const attenuation = rcasSharpnessToAttenuation(request.sharpness);
  const mode = isMode(request.mode) ? request.mode : "off";
  const idle: SpatialUpscalingState = { active: false, easu: false, rcas: false, attenuation, unavailableReason: null };
  if (mode === "off") return idle;
  if (request.backend === "webgl") return { ...idle, unavailableReason: SPATIAL_UPSCALING_WEBGL1_NOTE };
  if (!(request.effectiveRenderScale < 0.999)) return idle;
  const rcas = mode === "easu-rcas";
  return { active: true, easu: true, rcas, attenuation, unavailableReason: null };
}
