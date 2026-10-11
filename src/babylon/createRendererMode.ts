import { Engine, Scene, type EngineOptions, WebGPUEngine } from "@babylonjs/core";

import { probeWebGpuPresentation, type WebGpuPresentationProbeOptions } from "./webgpuPresentationProbe.js";
import type { RendererMode, RendererDiagnostics, RendererSelection as GenericRendererSelection, RendererModeOptions } from "../rendererTypes.js";
export type { RendererMode, RendererDiagnostics, RendererModeOptions } from "../rendererTypes.js";
export type RendererSelection = GenericRendererSelection<Engine | WebGPUEngine>;

/** Environment, preferences and presentation waits are explicit host ports. */
export interface RendererBootstrapHost {
  readPreference(): RendererMode | null;
  savePreference(mode: RendererMode): void;
  createProbeCanvas(): HTMLCanvasElement;
  devicePixelRatio(): number;
  diagnostics(): Pick<RendererDiagnostics, "navigatorGpuPresent" | "isSecureContext">;
  presentation: WebGpuPresentationProbeOptions;
  report?(level: "log" | "info" | "warn", message: string, detail?: unknown): void;
}
export interface RendererBootstrapOptions extends RendererModeOptions { host: RendererBootstrapHost; }

interface WebGpuEngineOptions {
  antialias: boolean;
  adaptToDeviceRatio: boolean;
}

const WEBGL_ENGINE_OPTIONS: EngineOptions = {
  preserveDrawingBuffer: false,
  stencil: true,
  useLargeWorldRendering: true,
};

const DEFAULT_WEBGPU_OPTIONS: WebGpuEngineOptions = {
  antialias: true,
  adaptToDeviceRatio: true,
};

const SAFE_WEBGPU_OPTIONS: WebGpuEngineOptions = {
  antialias: false,
  adaptToDeviceRatio: false,
};

function createWebGlEngine(canvas: HTMLCanvasElement, antialias: boolean, preferWebGl1 = false): Engine {
  const options = preferWebGl1 ? { ...WEBGL_ENGINE_OPTIONS, disableWebGL2Support: true } : WEBGL_ENGINE_OPTIONS;
  const engine = new Engine(canvas, antialias, options, true);
  // A globe and a near camera share one depth buffer. Conventional depth
  // collapses distinct distant surfaces into the same value; reversing it
  // keeps their separation without another pass or fragment-depth shader.
  engine.useReverseDepthBuffer = true;
  return engine;
}

function actualWebGLMode(engine: Engine): "webgl" | "webgl2" {
  const v = (engine as unknown as { webGLVersion?: number }).webGLVersion;
  return v === 1 ? "webgl" : "webgl2";
}

function createRendererScene(engine: Engine | WebGPUEngine): Scene {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  // Babylon otherwise raycasts the whole scene on every pointer move. Anchor
  // pans pick explicitly.
  scene.skipPointerMovePicking = true;
  return scene;
}

function getRendererDiagnostics(host: RendererBootstrapHost, isSupportedAsyncResult: boolean | null = null): RendererDiagnostics {
  return { ...host.diagnostics(), isSupportedAsyncResult };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function persistWorkingRenderer(mode: RendererMode, host: RendererBootstrapHost): void {
  try { host.savePreference(mode); } catch { /* persistence must not prevent a working backend */ }
}

function applyCanvasDimensions(
  canvas: HTMLCanvasElement,
  reference: HTMLCanvasElement,
  adaptToDeviceRatio: boolean,
  host: RendererBootstrapHost,
): void {
  const cssWidth = reference.clientWidth || reference.width || 300;
  const cssHeight = reference.clientHeight || reference.height || 150;
  const dpr = adaptToDeviceRatio ? host.devicePixelRatio() || 1 : 1;
  canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
  canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
}

async function createWebGpuEngine(
  canvas: HTMLCanvasElement,
  options: WebGpuEngineOptions,
): Promise<WebGPUEngine> {
  const webGpuEngine = new WebGPUEngine(canvas, {
    antialias: options.antialias,
    adaptToDeviceRatio: options.adaptToDeviceRatio,
    useLargeWorldRendering: true,
    // Lets a profiler time the GPU's render passes. Babylon drops it where the adapter
    // lacks it, and it costs nothing until timing is switched on.
    deviceDescriptor: { requiredFeatures: ["timestamp-query"] },
  });
  try { await webGpuEngine.initAsync(); } catch (error) { webGpuEngine.dispose(); throw error; }
  webGpuEngine.useReverseDepthBuffer = true;
  return webGpuEngine;
}

/**
 * Probe WebGPU on a throwaway canvas so the runtime canvas stays eligible for
 * WebGL if presentation fails. A canvas that has ever hosted WebGPU cannot
 * reliably acquire a WebGL context afterward in Chromium.
 */
async function probeWebGpuOnOffscreenCanvas(
  targetCanvas: HTMLCanvasElement,
  options: WebGpuEngineOptions,
  host: RendererBootstrapHost,
) {
  const probeCanvas = host.createProbeCanvas();
  applyCanvasDimensions(probeCanvas, targetCanvas, options.adaptToDeviceRatio, host);

  let engine: WebGPUEngine | null = null;
  let scene: Scene | null = null;
  try {
    engine = await createWebGpuEngine(probeCanvas, options);
    scene = createRendererScene(engine);
    engine.resize();
    return await probeWebGpuPresentation(engine, scene, host.presentation);
  } finally {
    try { scene?.dispose(); } finally { engine?.dispose(); }
  }
}

function createWebGlSelection(
  canvas: HTMLCanvasElement,
  host: RendererBootstrapHost,
  requested: RendererMode | "auto",
  antialias: boolean,
  fallbackReason?: string,
  diagnostics?: RendererDiagnostics,
): RendererSelection {
  const engine = createWebGlEngine(canvas, antialias);
  const mode = actualWebGLMode(engine);
  persistWorkingRenderer(mode, host);
  return {
    requested,
    mode,
    engine,
    fallbackReason,
    diagnostics,
    antialias,
    devicePixels: true,
  };
}

function createWebGlBootstrap(
  canvas: HTMLCanvasElement,
  host: RendererBootstrapHost,
  requested: RendererMode | "auto",
  antialias: boolean,
  fallbackReason?: string,
  diagnostics?: RendererDiagnostics,
): { renderer: RendererSelection; scene: Scene } {
  const renderer = createWebGlSelection(canvas, host, requested, antialias, fallbackReason, diagnostics);
  return {
    renderer,
    scene: createRendererScene(renderer.engine),
  };
}

async function initializeWebGpuRenderer(
  canvas: HTMLCanvasElement,
  host: RendererBootstrapHost,
  requested: RendererMode | "auto",
  diagnostics: RendererDiagnostics,
  antialias: boolean,
): Promise<{ renderer: RendererSelection; scene: Scene }> {
  const attempts: WebGpuEngineOptions[] = [{ ...DEFAULT_WEBGPU_OPTIONS, antialias }, SAFE_WEBGPU_OPTIONS];
  let lastError = "";

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const options = attempts[attempt]!;
    const probe = await probeWebGpuOnOffscreenCanvas(canvas, options, host);

    if (probe.ok) {
      const engine = await createWebGpuEngine(canvas, options);
      persistWorkingRenderer("webgpu", host);
      return {
        renderer: {
          requested,
          mode: "webgpu",
          engine,
          diagnostics,
          antialias: options.antialias,
          devicePixels: options.adaptToDeviceRatio,
        },
        scene: createRendererScene(engine),
      };
    }

    lastError = probe.errors[0] ?? "WebGPU presentation probe failed";
    if (attempt === 0) {
      host.report?.("warn",
        "[renderer] WebGPU presentation probe failed with default options; retrying with antialias=false and adaptToDeviceRatio=false.",
        { reason: lastError },
      );
    } else {
      host.report?.("warn", "[renderer] WebGPU presentation probe failed.", { reason: lastError, errors: probe.errors });
    }
  }

  host.report?.("warn",
    "[renderer] WebGPU cannot present on this device. Falling back to WebGL.",
    { reason: lastError },
  );

  return createWebGlBootstrap(canvas, host, requested, antialias, lastError, diagnostics);
}

async function tryWebGpuBootstrap(
  canvas: HTMLCanvasElement,
  host: RendererBootstrapHost,
  requested: RendererMode | "auto",
  diagnostics: RendererDiagnostics,
  antialias: boolean,
): Promise<{ renderer: RendererSelection; scene: Scene }> {
  try {
    const isSupported = await WebGPUEngine.IsSupportedAsync;
    diagnostics.isSupportedAsyncResult = isSupported;
    if (requested === "webgpu") {
      host.report?.("log", `[renderer] WebGPUEngine.IsSupportedAsync: ${isSupported}`);
    }
    if (!isSupported) {
      return createWebGlBootstrap(
        canvas,
        host,
        requested,
        antialias,
        "WebGPUEngine.IsSupportedAsync returned false",
        diagnostics,
      );
    }

    return await initializeWebGpuRenderer(canvas, host, requested, diagnostics, antialias);
  } catch (error) {
    const reason = getErrorMessage(error);
    host.report?.("warn", "[renderer] WebGPU initialization failed. Falling back to WebGL.", error);
    diagnostics.isSupportedAsyncResult ??= false;
    return createWebGlBootstrap(canvas, host, requested, antialias, reason, diagnostics);
  }
}

/**
 * Pick a renderer, create the real runtime scene, and verify WebGPU can present
 * on an offscreen canvas before the runtime canvas is touched.
 */
export async function bootstrapRenderer(
  canvas: HTMLCanvasElement,
  options: RendererBootstrapOptions,
): Promise<{ renderer: RendererSelection; scene: Scene }> {
  const host = options.host;
  const force = options.force ?? null;
  const antialias = options.antialias ?? true;

  if (force === "webgpu") {
    const diagnostics = getRendererDiagnostics(host, null);
    host.report?.("log",
      `[renderer] Forced WebGPU requested. navigator.gpu present: ${diagnostics.navigatorGpuPresent}, isSecureContext: ${diagnostics.isSecureContext}`,
      diagnostics,
    );
    return tryWebGpuBootstrap(canvas, host, "webgpu", diagnostics, antialias);
  }

  if (force === "webgl2" || force === "webgl") {
    const engine = createWebGlEngine(canvas, antialias, force === "webgl");
    const mode = actualWebGLMode(engine);
    if (force === "webgl2" && mode !== "webgl2") {
      engine.dispose();
      throw new Error("Forced WebGL2 is unavailable on this canvas");
    }
    persistWorkingRenderer(mode, host);
    return {
      renderer: {
        requested: force,
        mode,
        engine,
        antialias,
        devicePixels: true,
      },
      scene: createRendererScene(engine),
    };
  }

  let persisted: RendererMode | null = null;
  try { persisted = host.readPreference(); } catch { /* use normal detection if storage is unavailable */ }
  if (persisted === "webgl2" || persisted === "webgl") {
    host.report?.("info", `[renderer] Using persisted client renderer preference: ${persisted}`);
    const engine = createWebGlEngine(canvas, antialias, persisted === "webgl");
    const mode = actualWebGLMode(engine);
    persistWorkingRenderer(mode, host);
    return {
      renderer: {
        requested: "auto",
        mode,
        engine,
        antialias,
        devicePixels: true,
        diagnostics: {
          ...getRendererDiagnostics(host),
          fromPersistedPreference: true,
        },
      },
      scene: createRendererScene(engine),
    };
  }

  if (persisted === "webgpu") {
    host.report?.("info", "[renderer] Using persisted client renderer preference: webgpu");
    return tryWebGpuBootstrap(canvas, host, "auto", {
      ...getRendererDiagnostics(host, null),
      fromPersistedPreference: true,
    }, antialias);
  }

  return tryWebGpuBootstrap(canvas, host, "auto", getRendererDiagnostics(host, null), antialias);
}

/** @deprecated Use bootstrapRenderer; engine-only callers do not retain a hidden scene. */
export async function createRendererMode(
  canvas: HTMLCanvasElement,
  options: RendererBootstrapOptions,
): Promise<RendererSelection> {
  const { renderer, scene } = await bootstrapRenderer(canvas, options);
  scene.dispose();
  return renderer;
}

/** Compatibility alias for the existing host facade. */
export const bootstrapGlobeRenderer = bootstrapRenderer;
