import type { RendererMode } from "./rendererTypes.js";

/** Remembered working result; separate from the user's renderer.backend choice. Only WebGPU is saved. */
export const RENDERER_PREFERENCE_STORAGE_KEY = "foss-earth:renderer-preference";
/** Why the last WebGPU start failed, and what was true then. A fallback is never saved as the preference. */
export const RENDERER_FALLBACK_STORAGE_KEY = "foss-earth:renderer-fallback";
/** That WebGPU presented here, so that a later start in the same browser need not probe it again. */
export const RENDERER_WEBGPU_VERIFIED_STORAGE_KEY = "foss-earth:renderer-webgpu-verified";
/** A passed probe is trusted this long; then WebGPU is probed again. */
export const RENDERER_WEBGPU_VERIFIED_MS = 30 * 24 * 60 * 60 * 1000;
/** A saved fallback is trusted this long; then WebGPU is tried again. */
export const RENDERER_FALLBACK_RETRY_MS = 3 * 24 * 60 * 60 * 1000;
export interface RendererPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const validModes = new Set<RendererMode>(["webgpu", "webgl2", "webgl"]);

export function readRendererPreference(storage: RendererPreferenceStorage): RendererMode | null {
  try {
    const value = storage.getItem(RENDERER_PREFERENCE_STORAGE_KEY);
    if (value && validModes.has(value as RendererMode)) return value as RendererMode;
  } catch { /* privacy/quota restrictions preserve auto detection */ }
  return null;
}
/** Saves the mode that worked, or with null forgets it. */
export function saveRendererPreference(mode: RendererMode | null, storage: RendererPreferenceStorage): void {
  try {
    if (mode) storage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, mode);
    else storage.removeItem(RENDERER_PREFERENCE_STORAGE_KEY);
  } catch { /* no persistence available */ }
}
/** Forgets the working mode, any fallback and any passed probe, so automatic mode starts from WebGPU again. */
export function clearRendererPreference(storage: RendererPreferenceStorage): void {
  saveRendererPreference(null, storage);
  saveRendererFallback(null, storage);
  saveWebGpuVerification(null, storage);
}

/** The engine options WebGPU presented with on a throwaway canvas, in which browser, and when. */
export interface WebGpuVerification {
  antialias: boolean;
  adaptToDeviceRatio: boolean;
  userAgent: string;
  /** When the probe passed, in milliseconds since 1970. */
  at: number;
}

export function readWebGpuVerification(storage: RendererPreferenceStorage): WebGpuVerification | null {
  try {
    const value = storage.getItem(RENDERER_WEBGPU_VERIFIED_STORAGE_KEY);
    if (!value) return null;
    const saved = JSON.parse(value) as Partial<WebGpuVerification> | null;
    if (!saved || typeof saved.antialias !== "boolean" || typeof saved.adaptToDeviceRatio !== "boolean"
      || typeof saved.userAgent !== "string" || typeof saved.at !== "number" || !Number.isFinite(saved.at)) return null;
    const { antialias, adaptToDeviceRatio, userAgent, at } = saved;
    return { antialias, adaptToDeviceRatio, userAgent, at };
  } catch { return null; }
}
/** Saves a passed probe, or with null forgets it. */
export function saveWebGpuVerification(verification: WebGpuVerification | null, storage: RendererPreferenceStorage): void {
  try {
    if (verification) storage.setItem(RENDERER_WEBGPU_VERIFIED_STORAGE_KEY, JSON.stringify(verification));
    else storage.removeItem(RENDERER_WEBGPU_VERIFIED_STORAGE_KEY);
  } catch { /* no persistence available */ }
}

/** Whether a passed probe still holds in this browser now: the same user agent, within its time. */
export function webGpuVerificationHolds(verification: WebGpuVerification, now: { userAgent: string; at: number }): boolean {
  return verification.userAgent === now.userAgent && now.at >= verification.at && now.at - verification.at < RENDERER_WEBGPU_VERIFIED_MS;
}

/** What a WebGPU start depends on that can change on the same origin. */
export interface RendererFallbackFacts {
  isSecureContext: boolean;
  navigatorGpuPresent: boolean;
  /** An update may have fixed WebGPU, or brought it. */
  userAgent: string;
}
export interface RendererFallback extends RendererFallbackFacts {
  mode: "webgl2" | "webgl";
  reason: string;
  /** When WebGPU failed, in milliseconds since 1970. */
  at: number;
}

export function readRendererFallback(storage: RendererPreferenceStorage): RendererFallback | null {
  try {
    const value = storage.getItem(RENDERER_FALLBACK_STORAGE_KEY);
    if (!value) return null;
    const saved = JSON.parse(value) as Partial<RendererFallback> | null;
    if (!saved || (saved.mode !== "webgl2" && saved.mode !== "webgl") || typeof saved.reason !== "string"
      || typeof saved.at !== "number" || !Number.isFinite(saved.at) || typeof saved.isSecureContext !== "boolean"
      || typeof saved.navigatorGpuPresent !== "boolean" || typeof saved.userAgent !== "string") return null;
    const { mode, reason, at, isSecureContext, navigatorGpuPresent, userAgent } = saved;
    return { mode, reason, at, isSecureContext, navigatorGpuPresent, userAgent };
  } catch { return null; }
}
/** Saves a fallback, or with null forgets it. */
export function saveRendererFallback(fallback: RendererFallback | null, storage: RendererPreferenceStorage): void {
  try {
    if (fallback) storage.setItem(RENDERER_FALLBACK_STORAGE_KEY, JSON.stringify(fallback));
    else storage.removeItem(RENDERER_FALLBACK_STORAGE_KEY);
  } catch { /* no persistence available */ }
}

/** Why a saved fallback no longer holds, so WebGPU is worth trying again, or null while it holds. */
export function staleFallbackReason(fallback: RendererFallback, now: RendererFallbackFacts & { at: number }): string | null {
  if (!fallback.isSecureContext && now.isSecureContext) return "the page is now a secure context";
  if (!fallback.navigatorGpuPresent && now.navigatorGpuPresent) return "the browser now offers WebGPU";
  if (fallback.userAgent !== now.userAgent) return "the browser has changed since";
  if (now.at < fallback.at || now.at - fallback.at >= RENDERER_FALLBACK_RETRY_MS) return "the fallback is more than three days old";
  return null;
}
