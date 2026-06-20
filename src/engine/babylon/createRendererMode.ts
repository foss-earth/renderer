import { Engine, Scene, type EngineOptions, WebGPUEngine } from "@babylonjs/core";

import {
  readRendererPreference,
  saveRendererPreference,
} from "./rendererPreference";
import { probeWebGpuPresentation } from "./webgpuPresentationProbe";

export type RendererMode = "webgpu" | "webgl2" | "webgl";

export interface RendererDiagnostics {
  navigatorGpuPresent: boolean;
  /** null if IsSupportedAsync was never checked (e.g. non-WebGPU path). */
  isSupportedAsyncResult: boolean | null;
  isSecureContext: boolean;
  /** True when auto mode used a client-side persisted working renderer. */
  fromPersistedPreference?: boolean;
}

export interface RendererSelection {
  /** The renderer the user explicitly requested, or "auto" for auto-detect. */
  requested: RendererMode | "auto";
  /** The renderer that was actually initialised. */
  mode: RendererMode;
  engine: Engine | WebGPUEngine;
  /** If a forced renderer fell back, this is the error message explaining why. */
  fallbackReason?: string;
  /** Low-level diagnostics captured during renderer selection. */
  diagnostics?: RendererDiagnostics;
}

export interface RendererModeOptions {
  /**
   * Force a specific renderer.  When null/undefined the runtime auto-detects
   * WebGPU → WebGL2 → WebGL in that order (or uses a persisted client preference).
   */
  force?: RendererMode | null;
}

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

function createWebGlEngine(canvas: HTMLCanvasElement): Engine {
  return new Engine(canvas, true, WEBGL_ENGINE_OPTIONS, true);
}

function actualWebGLMode(engine: Engine): "webgl" | "webgl2" {
  const v = (engine as unknown as { webGLVersion?: number }).webGLVersion;
  return v === 1 ? "webgl" : "webgl2";
}

function createGlobeScene(engine: Engine | WebGPUEngine): Scene {
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  return scene;
}

function getRendererDiagnostics(isSupportedAsyncResult: boolean | null = null): RendererDiagnostics {
  return {
    navigatorGpuPresent: typeof navigator !== "undefined" && "gpu" in navigator,
    isSupportedAsyncResult,
    isSecureContext: typeof isSecureContext !== "undefined" ? isSecureContext : false,
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function persistWorkingRenderer(mode: RendererMode): void {
  saveRendererPreference(mode);
}

function applyCanvasDimensions(
  canvas: HTMLCanvasElement,
  reference: HTMLCanvasElement,
  adaptToDeviceRatio: boolean,
): void {
  const cssWidth = reference.clientWidth || reference.width || 300;
  const cssHeight = reference.clientHeight || reference.height || 150;
  const dpr = adaptToDeviceRatio ? window.devicePixelRatio || 1 : 1;
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
  });
  await webGpuEngine.initAsync();
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
) {
  const probeCanvas = document.createElement("canvas");
  applyCanvasDimensions(probeCanvas, targetCanvas, options.adaptToDeviceRatio);

  let engine: WebGPUEngine | null = null;
  let scene: Scene | null = null;
  try {
    engine = await createWebGpuEngine(probeCanvas, options);
    scene = createGlobeScene(engine);
    engine.resize();
    return await probeWebGpuPresentation(engine, scene);
  } finally {
    scene?.dispose();
    engine?.dispose();
  }
}

function createWebGlSelection(
  canvas: HTMLCanvasElement,
  requested: RendererMode | "auto",
  fallbackReason?: string,
  diagnostics?: RendererDiagnostics,
): RendererSelection {
  const engine = createWebGlEngine(canvas);
  const mode = actualWebGLMode(engine);
  persistWorkingRenderer(mode);
  return {
    requested,
    mode,
    engine,
    fallbackReason,
    diagnostics,
  };
}

function createWebGlBootstrap(
  canvas: HTMLCanvasElement,
  requested: RendererMode | "auto",
  fallbackReason?: string,
  diagnostics?: RendererDiagnostics,
): { renderer: RendererSelection; scene: Scene } {
  const renderer = createWebGlSelection(canvas, requested, fallbackReason, diagnostics);
  return {
    renderer,
    scene: createGlobeScene(renderer.engine),
  };
}

async function initializeWebGpuRenderer(
  canvas: HTMLCanvasElement,
  requested: RendererMode | "auto",
  diagnostics: RendererDiagnostics,
): Promise<{ renderer: RendererSelection; scene: Scene }> {
  const attempts: WebGpuEngineOptions[] = [DEFAULT_WEBGPU_OPTIONS, SAFE_WEBGPU_OPTIONS];
  let lastError = "";

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const options = attempts[attempt]!;
    const probe = await probeWebGpuOnOffscreenCanvas(canvas, options);

    if (probe.ok) {
      const engine = await createWebGpuEngine(canvas, options);
      persistWorkingRenderer("webgpu");
      return {
        renderer: {
          requested,
          mode: "webgpu",
          engine,
          diagnostics,
        },
        scene: createGlobeScene(engine),
      };
    }

    lastError = probe.errors[0] ?? "WebGPU presentation probe failed";
    if (attempt === 0) {
      console.warn(
        "[renderer] WebGPU presentation probe failed with default options; retrying with antialias=false and adaptToDeviceRatio=false.",
        { reason: lastError },
      );
    } else {
      console.warn("[renderer] WebGPU presentation probe failed.", { reason: lastError, errors: probe.errors });
    }
  }

  console.warn(
    "[renderer] WebGPU cannot present on this device. Falling back to WebGL.",
    { reason: lastError },
  );

  return createWebGlBootstrap(canvas, requested, lastError, diagnostics);
}

async function tryWebGpuBootstrap(
  canvas: HTMLCanvasElement,
  requested: RendererMode | "auto",
  diagnostics: RendererDiagnostics,
): Promise<{ renderer: RendererSelection; scene: Scene }> {
  try {
    const isSupported = await WebGPUEngine.IsSupportedAsync;
    diagnostics.isSupportedAsyncResult = isSupported;
    if (requested === "webgpu") {
      console.log(`[renderer] WebGPUEngine.IsSupportedAsync: ${isSupported}`);
    }
    if (!isSupported) {
      return createWebGlBootstrap(
        canvas,
        requested,
        "WebGPUEngine.IsSupportedAsync returned false",
        diagnostics,
      );
    }

    return initializeWebGpuRenderer(canvas, requested, diagnostics);
  } catch (error) {
    const reason = getErrorMessage(error);
    console.warn("[renderer] WebGPU initialization failed. Falling back to WebGL.", error);
    diagnostics.isSupportedAsyncResult ??= false;
    return createWebGlBootstrap(canvas, requested, reason, diagnostics);
  }
}

/**
 * Pick a renderer, create the real runtime scene, and verify WebGPU can present
 * on an offscreen canvas before the runtime canvas is touched.
 */
export async function bootstrapGlobeRenderer(
  canvas: HTMLCanvasElement,
  options: RendererModeOptions = {},
): Promise<{ renderer: RendererSelection; scene: Scene }> {
  const force = options.force ?? null;

  if (force === "webgpu") {
    const diagnostics = getRendererDiagnostics(null);
    console.log(
      `[renderer] Forced WebGPU requested. navigator.gpu present: ${diagnostics.navigatorGpuPresent}, isSecureContext: ${diagnostics.isSecureContext}`,
      diagnostics.navigatorGpuPresent ? navigator.gpu : "(missing)",
    );
    return tryWebGpuBootstrap(canvas, "webgpu", diagnostics);
  }

  if (force === "webgl2" || force === "webgl") {
    const engine = createWebGlEngine(canvas);
    const mode = actualWebGLMode(engine);
    persistWorkingRenderer(mode);
    return {
      renderer: {
        requested: force,
        mode,
        engine,
      },
      scene: createGlobeScene(engine),
    };
  }

  const persisted = readRendererPreference();
  if (persisted === "webgl2" || persisted === "webgl") {
    console.info(`[renderer] Using persisted client renderer preference: ${persisted}`);
    const engine = createWebGlEngine(canvas);
    const mode = actualWebGLMode(engine);
    persistWorkingRenderer(mode);
    return {
      renderer: {
        requested: "auto",
        mode,
        engine,
        diagnostics: {
          ...getRendererDiagnostics(),
          fromPersistedPreference: true,
        },
      },
      scene: createGlobeScene(engine),
    };
  }

  if (persisted === "webgpu") {
    console.info("[renderer] Using persisted client renderer preference: webgpu");
    return tryWebGpuBootstrap(canvas, "auto", {
      ...getRendererDiagnostics(null),
      fromPersistedPreference: true,
    });
  }

  return tryWebGpuBootstrap(canvas, "auto", getRendererDiagnostics(null));
}

/** @deprecated Use bootstrapGlobeRenderer — kept for tests and direct engine-only callers. */
export async function createRendererMode(
  canvas: HTMLCanvasElement,
  options: RendererModeOptions = {},
): Promise<RendererSelection> {
  const { renderer } = await bootstrapGlobeRenderer(canvas, options);
  return renderer;
}
