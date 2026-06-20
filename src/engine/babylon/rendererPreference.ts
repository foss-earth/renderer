import type { RendererMode } from "./createRendererMode";

export const RENDERER_PREFERENCE_STORAGE_KEY = "foss-earth:renderer-preference";

const VALID_MODES = new Set<RendererMode>(["webgpu", "webgl2", "webgl"]);

export function readRendererPreference(): RendererMode | null {
  try {
    const value = window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY);
    if (value && VALID_MODES.has(value as RendererMode)) {
      return value as RendererMode;
    }
  } catch {
    // ignore quota / privacy mode
  }
  return null;
}

export function saveRendererPreference(mode: RendererMode): void {
  try {
    window.localStorage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

export function clearRendererPreference(): void {
  try {
    window.localStorage.removeItem(RENDERER_PREFERENCE_STORAGE_KEY);
  } catch {
    // ignore
  }
}
