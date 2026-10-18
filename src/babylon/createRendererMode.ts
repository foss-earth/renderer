import { Engine, Scene, type EngineOptions, WebGPUEngine } from "@babylonjs/core";
import { RecoverableWebGpuEngine } from "./recoverableWebGpuEngine.js";

import { probeWebGpuPresentation, watchWebGpuPresentation, type WebGpuPresentationProbeOptions } from "./webgpuPresentationProbe.js";
import type { RendererMode, RendererDiagnostics, RendererSelection as GenericRendererSelection, RendererModeOptions } from "../rendererTypes.js";
import { staleFallbackReason, webGpuVerificationHolds, type RendererFallback, type WebGpuVerification } from "../rendererPreference.js";
import type { ShaderChunkLanguage } from "../shaderChunks.js";
export type { RendererMode, RendererDiagnostics, RendererModeOptions } from "../rendererTypes.js";
export type RendererSelection = GenericRendererSelection<Engine | WebGPUEngine>;

/** Environment, preferences and presentation waits are explicit host ports. */
export interface RendererBootstrapHost {
  readPreference(): RendererMode | null;
  /** Saves the mode that worked, or with null forgets it. Only WebGPU is saved: WebGL is a fallback, kept with its reason. */
  savePreference(mode: RendererMode | null): void;
  /** Why WebGPU last failed here, so that automatic mode need not wait for it again until that may have changed. */
  readFallback(): RendererFallback | null;
  saveFallback(fallback: RendererFallback | null): void;
  /**
   * The options WebGPU presented with in a passed probe, so that a start in the same browser skips the probe, and
   * watches the page's canvas for the same errors instead. A host without these ports probes on every start.
   */
  readVerification?(): WebGpuVerification | null;
  saveVerification?(verification: WebGpuVerification | null): void;
  /** Starts the page again, when WebGPU fails on the page's canvas after a skipped probe. Without it the page stays as it is. */
  reload?(): void;
  /** The browser's user agent: an update may fix WebGPU. */
  userAgent(): string;
  /** Milliseconds since 1970. */
  now(): number;
  createProbeCanvas(): HTMLCanvasElement;
  devicePixelRatio(): number;
  diagnostics(): Pick<RendererDiagnostics, "navigatorGpuPresent" | "isSecureContext">;
  presentation: WebGpuPresentationProbeOptions;
  /**
   * Why this device needs WebGL in automatic mode, or null. Babylon presents
   * immersive WebXR sessions only from a WebGL context.
   */
  webGlRequirement?(): Promise<string | null>;
  /**
   * Starts fetching Babylon's shaders in the language of the backend being started, which the scene's
   * materials import when they first compile. A built page loads only one language (docs/vite.md).
   */
  preloadShaders?(language: ShaderChunkLanguage): void;
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

function preloadShaders(host: RendererBootstrapHost, language: ShaderChunkLanguage): void {
  try { host.preloadShaders?.(language); } catch { /* only a head start: the materials import what they need */ }
}

function createWebGlEngine(canvas: HTMLCanvasElement, host: RendererBootstrapHost, antialias: boolean, preferWebGl1 = false): Engine {
  preloadShaders(host, "glsl");
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

function persistWorkingRenderer(mode: RendererMode | null, host: RendererBootstrapHost): void {
  try { host.savePreference(mode); } catch { /* persistence must not prevent a working backend */ }
}

/** Remembers why WebGPU failed, with what was true then, in place of a preference for WebGL. */
function persistFallback(mode: "webgl2" | "webgl", reason: string, host: RendererBootstrapHost): void {
  try {
    const { navigatorGpuPresent, isSecureContext } = host.diagnostics();
    host.saveFallback({ mode, reason, at: host.now(), navigatorGpuPresent, isSecureContext, userAgent: host.userAgent() });
    host.savePreference(null);
  } catch { /* persistence must not prevent a working backend */ }
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
  host: RendererBootstrapHost,
): Promise<WebGPUEngine> {
  const webGpuEngine = new RecoverableWebGpuEngine(canvas, {
    antialias: options.antialias,
    adaptToDeviceRatio: options.adaptToDeviceRatio,
    useLargeWorldRendering: true,
    // Lets a profiler time the GPU's render passes. Babylon drops it where the adapter
    // lacks it, and it costs nothing until timing is switched on.
    deviceDescriptor: { requiredFeatures: ["timestamp-query"] },
  });
  if (host.report) webGpuEngine.onRestoreError = error => host.report!("warn", "[renderer] WebGPU device restoration failed.", error);
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
    engine = await createWebGpuEngine(probeCanvas, options, host);
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
  const engine = createWebGlEngine(canvas, host, antialias);
  const mode = actualWebGLMode(engine);
  persistFallback(mode, fallbackReason ?? "WebGPU did not start", host);
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

/** The attempt a passed probe in this browser vouches for, or null to probe. */
function verifiedOptions(host: RendererBootstrapHost, attempts: WebGpuEngineOptions[]): WebGpuEngineOptions | null {
  let verification: WebGpuVerification | null = null;
  try { verification = host.readVerification?.() ?? null; } catch { /* probe */ }
  if (!verification || !webGpuVerificationHolds(verification, { userAgent: host.userAgent(), at: host.now() })) return null;
  return attempts.find(options => options.antialias === verification.antialias && options.adaptToDeviceRatio === verification.adaptToDeviceRatio) ?? null;
}

/**
 * Starts WebGPU on the page's canvas without the probe, which passed in this browser before and costs several
 * frames and a pause. If the canvas shows a presentation error in its first frames, the passed probe is forgotten
 * and the page starts again, to probe and if need be fall back to WebGL, which this canvas can no longer give.
 */
async function startVerifiedWebGpu(
  canvas: HTMLCanvasElement,
  host: RendererBootstrapHost,
  requested: RendererMode | "auto",
  diagnostics: RendererDiagnostics,
  options: WebGpuEngineOptions,
): Promise<{ renderer: RendererSelection; scene: Scene }> {
  const engine = await createWebGpuEngine(canvas, options, host);
  host.report?.("info", "[renderer] WebGPU presented in this browser before; starting without the presentation probe.");
  watchWebGpuPresentation(engine, host.presentation, errors => {
    host.report?.("warn", "[renderer] WebGPU cannot present on this page's canvas. Starting again with the presentation probe.", { errors });
    try { host.saveVerification?.(null); } catch { /* the reload probes only if this is forgotten */ }
    host.reload?.();
  });
  return {
    renderer: { requested, mode: "webgpu", engine, diagnostics: { ...diagnostics, probeSkipped: true },
      antialias: options.antialias, devicePixels: options.adaptToDeviceRatio },
    scene: createRendererScene(engine),
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
  const verified = verifiedOptions(host, attempts);
  if (verified) return startVerifiedWebGpu(canvas, host, requested, diagnostics, verified);
  let lastError = "";

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const options = attempts[attempt]!;
    const probe = await probeWebGpuOnOffscreenCanvas(canvas, options, host);

    if (probe.ok) {
      const engine = await createWebGpuEngine(canvas, options, host);
      persistWorkingRenderer("webgpu", host);
      try { host.saveVerification?.({ ...options, userAgent: host.userAgent(), at: host.now() }); } catch { /* the next start probes again */ }
      try { host.saveFallback(null); } catch { /* persistence must not prevent a working backend */ }
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

    preloadShaders(host, "wgsl");
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
    const engine = createWebGlEngine(canvas, host, antialias, force === "webgl");
    const mode = actualWebGLMode(engine);
    if (force === "webgl2" && mode !== "webgl2") {
      engine.dispose();
      throw new Error("Forced WebGL2 is unavailable on this canvas");
    }
    // Not persisted: renderer.backend keeps the choice, and Auto must start from WebGPU again.
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
    // Earlier versions saved any fallback as the preference, which kept WebGL forever.
    host.report?.("info", `[renderer] Ignoring the saved ${persisted} preference of an earlier version; trying WebGPU.`);
    persistWorkingRenderer(null, host);
    persisted = null;
  }
  let requirement: string | null = null;
  try { requirement = await host.webGlRequirement?.() ?? null; } catch { /* use normal detection */ }
  if (requirement) {
    host.report?.("info", `[renderer] Using WebGL2: ${requirement}`);
    // Not persisted: the requirement is read again on every start.
    const engine = createWebGlEngine(canvas, host, antialias);
    return {
      renderer: { requested: "auto", mode: actualWebGLMode(engine), engine, antialias, devicePixels: true,
        fallbackReason: requirement, diagnostics: { ...getRendererDiagnostics(host), webGlRequired: true } },
      scene: createRendererScene(engine),
    };
  }
  let fallback: RendererFallback | null = null;
  try { fallback = host.readFallback(); } catch { /* use normal detection if storage is unavailable */ }
  if (fallback) {
    const diagnostics = getRendererDiagnostics(host);
    const stale = staleFallbackReason(fallback, { ...diagnostics, userAgent: host.userAgent(), at: host.now() });
    if (stale === null) {
      host.report?.("info", `[renderer] Using WebGL, since WebGPU failed here at ${new Date(fallback.at).toISOString()}: ${fallback.reason}`);
      const engine = createWebGlEngine(canvas, host, antialias);
      return {
        renderer: { requested: "auto", mode: actualWebGLMode(engine), engine, antialias, devicePixels: true,
          fallbackReason: fallback.reason,
          diagnostics: { ...diagnostics, fromPersistedPreference: true, fallbackSavedAt: fallback.at } },
        scene: createRendererScene(engine),
      };
    }
    host.report?.("info", `[renderer] Trying WebGPU again, since ${stale}. It failed at ${new Date(fallback.at).toISOString()}: ${fallback.reason}`);
    try { host.saveFallback(null); } catch { /* the next result replaces it */ }
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
