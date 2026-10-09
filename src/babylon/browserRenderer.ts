import { readRendererPreference, saveRendererPreference, clearRendererPreference, type RendererPreferenceStorage } from "../rendererPreference.js";
import type { RendererMode, RendererModeOptions } from "../rendererTypes.js";
import { bootstrapRenderer, type RendererBootstrapHost } from "./createRendererMode.js";
import type { PresentationProbePolicy } from "./webgpuPresentationProbe.js";
import type { RendererPlatformPort } from "./rendererLifecycle.js";

export interface BrowserRendererHostOptions {
  window?: Window;
  document?: Document;
  storage?: RendererPreferenceStorage;
  probePolicy?: Readonly<PresentationProbePolicy>;
  report?: RendererBootstrapHost["report"];
}

/** Browser ports are read on invocation, never while loading the pure contracts. */
export function createBrowserRendererHost(options: BrowserRendererHostOptions = {}): RendererBootstrapHost {
  const browserWindow = options.window ?? window;
  const browserDocument = options.document ?? document;
  // Read storage inside its guarded operation: accessing it may itself throw.
  const storage: RendererPreferenceStorage = options.storage ?? {
    getItem: key => browserWindow.localStorage.getItem(key),
    setItem: (key, value) => browserWindow.localStorage.setItem(key, value),
    removeItem: key => browserWindow.localStorage.removeItem(key),
  };
  return {
    readPreference: () => readRendererPreference(storage),
    savePreference: mode => saveRendererPreference(mode, storage),
    createProbeCanvas: () => browserDocument.createElement("canvas"),
    devicePixelRatio: () => browserWindow.devicePixelRatio || 1,
    diagnostics: () => ({ navigatorGpuPresent: "gpu" in browserWindow.navigator, isSecureContext: browserWindow.isSecureContext ?? false }),
    presentation: {
      nextFrame: () => new Promise<void>(resolve => browserWindow.requestAnimationFrame(() => resolve())),
      delay: ms => new Promise<void>(resolve => browserWindow.setTimeout(resolve, ms)),
      policy: options.probePolicy,
    },
    report: options.report,
  };
}

/** Compatibility default-port adapter; creates no scheduler or feature runtime. */
export function bootstrapBrowserRenderer(canvas: HTMLCanvasElement, options: RendererModeOptions = {}, hostOptions: BrowserRendererHostOptions = {}) {
  return bootstrapRenderer(canvas, { ...options, host: createBrowserRendererHost(hostOptions) });
}

/** Attach/detach environment listeners without owning the host scheduler. */
export function createBrowserRendererPlatform(options: Pick<BrowserRendererHostOptions, "window" | "document"> = {}): RendererPlatformPort {
  const browserWindow = options.window ?? window;
  const browserDocument = options.document ?? document;
  return {
    devicePixelRatio: () => browserWindow.devicePixelRatio || 1,
    isHidden: () => browserDocument.hidden,
    onResize(listener) { browserWindow.addEventListener("resize", listener); return () => browserWindow.removeEventListener("resize", listener); },
    onVisibilityChange(listener) { browserDocument.addEventListener("visibilitychange", listener); return () => browserDocument.removeEventListener("visibilitychange", listener); },
  };
}

export interface RendererChoiceSettingsPort { set(id: string, value: string): void; }
export interface RendererChoiceLocationPort { readonly href: string; assign(url: string): void; }

/** Preserve reload/URL cleanup; inject the settings owner, location and preference store. */
export function applyRendererChoice(force: RendererMode | null, settings: RendererChoiceSettingsPort, location: RendererChoiceLocationPort, storage: RendererPreferenceStorage): void {
  settings.set("renderer.backend", force ?? "auto");
  if (force === null) clearRendererPreference(storage);
  const url = new URL(location.href);
  url.searchParams.delete("renderer");
  url.searchParams.delete("set.renderer.backend");
  location.assign(url.toString());
}
