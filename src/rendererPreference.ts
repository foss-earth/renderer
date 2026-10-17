import type { RendererMode } from "./rendererTypes.js";

/** Remembered working result; separate from the user's renderer.backend choice. Only WebGPU is saved. */
export const RENDERER_PREFERENCE_STORAGE_KEY = "foss-earth:renderer-preference";
/** Why the last WebGPU start failed, and what was true then. A fallback is never saved as the preference. */
export const RENDERER_FALLBACK_STORAGE_KEY = "foss-earth:renderer-fallback";
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
/** Forgets the working mode and any fallback, so automatic mode starts from WebGPU again. */
export function clearRendererPreference(storage: RendererPreferenceStorage): void {
  saveRendererPreference(null, storage);
  saveRendererFallback(null, storage);
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
