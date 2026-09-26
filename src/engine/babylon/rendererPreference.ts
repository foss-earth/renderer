import type { RendererMode } from "./createRendererMode";
import { getAppSettings } from "../../settings/appSettings";
import type { SettingsRegistry } from "../../settings/registry";

/**
 * The renderer that last started on this device. Auto-detect starts with it,
 * so a device where WebGPU failed does not probe it on every visit. It is a
 * remembered result, not the user's choice, which is `renderer.backend`.
 */
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

/**
 * Saves the user's renderer, `renderer.backend`, and reloads, since a
 * renderer starts only with the page. Auto-detect also forgets the renderer
 * that last worked, so WebGPU is tried again.
 */
export function applyRendererChoice(force: RendererMode | null, settings: SettingsRegistry = getAppSettings()): void {
  settings.set("renderer.backend", force ?? "auto");
  if (force === null) clearRendererPreference();
  const url = new URL(window.location.href);
  url.searchParams.delete("renderer");
  url.searchParams.delete("set.renderer.backend");
  window.location.assign(url.toString());
}
