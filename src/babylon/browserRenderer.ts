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

const WORLD_RESIZE_SETTLE_MS = 150;

/** Attach/detach environment listeners without owning the host scheduler. */
export function createBrowserRendererPlatform(options: Pick<BrowserRendererHostOptions, "window" | "document"> & { canvas?: HTMLElement } = {}): RendererPlatformPort {
  const browserWindow = options.window ?? window;
  const browserDocument = options.document ?? document;
  return {
    devicePixelRatio: () => browserWindow.devicePixelRatio || 1,
    isHidden: () => browserDocument.hidden,
    onResize(listener) {
      const root = browserDocument.documentElement;
      const canvas = options.canvas ?? null;
      const deferred = (): boolean => root.dataset.worldResize === "release";
      let held = false;
      let swallow = false;
      let timer = 0;
      let frame = 0;
      let locked = false;
      let committed: { width: number; height: number } | null = null;
      const remember = (): void => {
        if (!canvas) return;
        const box = canvas.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) committed = { width: box.width, height: box.height };
      };
      const unlock = (): void => {
        if (!locked || !canvas) return;
        canvas.style.width = "";
        canvas.style.height = "";
        locked = false;
      };
      // The resize event arrives after the window has already changed shape, so the
      // buffer stays at the size from the previous settle until this gesture ends.
      const lock = (): void => {
        if (locked || !canvas || !committed) return;
        const box = canvas.getBoundingClientRect();
        if (Math.abs(box.width - committed.width) < 0.5 && Math.abs(box.height - committed.height) < 0.5) return;
        canvas.style.width = `${committed.width}px`;
        canvas.style.height = `${committed.height}px`;
        locked = true;
      };
      const cancelPending = (): void => {
        if (timer) { browserWindow.clearTimeout(timer); timer = 0; }
        if (frame) { browserWindow.cancelAnimationFrame(frame); frame = 0; }
      };
      const deliver = (): void => { listener(); remember(); };
      const settle = (): void => {
        cancelPending();
        delete root.dataset.worldDrawHeld;
        unlock();
        swallow = true;
        browserWindow.dispatchEvent(new Event("foss-earth-world-draw-commit"));
        frame = browserWindow.requestAnimationFrame(() => { frame = 0; swallow = false; deliver(); });
      };
      const onLive = (): void => {
        cancelPending();
        held = false;
        swallow = false;
        delete root.dataset.worldDrawHeld;
        unlock();
        deliver();
      };
      // Window and visual-viewport events mean the browser itself is changing shape.
      // The canvas observer also follows a split window settling, and that one resize stands.
      const onBrowserShape = (): void => {
        if (!deferred()) { onLive(); return; }
        if (held || swallow) return;
        root.dataset.worldDrawHeld = "true";
        lock();
        cancelPending();
        timer = browserWindow.setTimeout(() => { timer = 0; settle(); }, WORLD_RESIZE_SETTLE_MS);
      };
      const onCanvas = (): void => {
        if (!deferred()) { onLive(); return; }
        if (held || swallow || timer || frame) return;
        swallow = true;
        frame = browserWindow.requestAnimationFrame(() => { frame = 0; swallow = false; deliver(); });
      };
      const onPanelStart = (): void => {
        if (!deferred()) return;
        held = true;
        cancelPending();
      };
      const onPanelEnd = (): void => {
        if (!held) return;
        held = false;
        if (!deferred()) return;
        settle();
      };
      const onMode = (): void => { if (!deferred()) onLive(); };
      // A window moved to a display of another density changes the device
      // pixel ratio without changing shape, and no resize event says so.
      let offDensity: (() => void) | null = null;
      const watchDensity = (): void => {
        offDensity?.();
        offDensity = null;
        if (typeof browserWindow.matchMedia !== "function") return;
        const query = browserWindow.matchMedia(`(resolution: ${browserWindow.devicePixelRatio || 1}dppx)`);
        const onDensity = (): void => { watchDensity(); onBrowserShape(); };
        query.addEventListener("change", onDensity);
        offDensity = () => query.removeEventListener("change", onDensity);
      };
      watchDensity();
      browserWindow.addEventListener("resize", onBrowserShape);
      browserWindow.visualViewport?.addEventListener("resize", onBrowserShape);
      browserWindow.addEventListener("foss-earth-panel-resize-start", onPanelStart);
      browserWindow.addEventListener("foss-earth-panel-resize-end", onPanelEnd);
      const Observer = (browserWindow as Window & { ResizeObserver?: new (callback: () => void) => { observe(target: Element): void; disconnect(): void } }).ResizeObserver;
      const observer = canvas && typeof Observer === "function" ? new Observer(onCanvas) : null;
      if (canvas) observer?.observe(canvas);
      const ModeObserver = (browserWindow as Window & { MutationObserver?: new (callback: () => void) => { observe(target: Node, options: { attributes: boolean; attributeFilter: string[] }): void; disconnect(): void } }).MutationObserver;
      const modeObserver = typeof ModeObserver === "function" ? new ModeObserver(onMode) : null;
      modeObserver?.observe(root, { attributes: true, attributeFilter: ["data-world-resize"] });
      remember();
      return () => {
        cancelPending();
        unlock();
        delete root.dataset.worldDrawHeld;
        browserWindow.removeEventListener("resize", onBrowserShape);
        browserWindow.visualViewport?.removeEventListener("resize", onBrowserShape);
        browserWindow.removeEventListener("foss-earth-panel-resize-start", onPanelStart);
        browserWindow.removeEventListener("foss-earth-panel-resize-end", onPanelEnd);
        observer?.disconnect();
        modeObserver?.disconnect();
        offDensity?.();
        offDensity = null;
      };
    },
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
