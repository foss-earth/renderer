import type { RendererMode } from "./rendererTypes.js";

/** Remembered working result; separate from the user's renderer.backend choice. */
export const RENDERER_PREFERENCE_STORAGE_KEY = "foss-earth:renderer-preference";
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
export function saveRendererPreference(mode: RendererMode, storage: RendererPreferenceStorage): void {
  try { storage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, mode); } catch { /* no persistence available */ }
}
export function clearRendererPreference(storage: RendererPreferenceStorage): void {
  try { storage.removeItem(RENDERER_PREFERENCE_STORAGE_KEY); } catch { /* no persistence available */ }
}
