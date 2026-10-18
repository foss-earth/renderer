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
   * The WebGPU options this browser starts with: in automatic mode those saved before a start on the page's canvas,
   * which presented or are the next to try, and with WebGPU chosen those a passed probe vouches for. A start skips
   * the probe for them, and watches the page's canvas for the same errors instead. A host without these ports and
   * `reload` probes on every start.
   */
  readVerification?(): WebGpuVerification | null;
  saveVerification?(verification: WebGpuVerification | null): void;
  /**
   * Starts the page again when WebGPU fails on the page's canvas, which can then give no WebGL context, so that the
   * next start begins as saved. Without it automatic mode probes first, and a failure after a skipped probe stays.
   */
  reload?(): void;
  /**
   * Whether the browser offers a WebGPU adapter, where the page asked before the renderer loaded, as a page built
   * with `babylonShaderChunks()` does (docs/vite.md); or null, and the bootstrap asks then.
   */
  earlyWebGpuSupport?(): Promise<boolean> | null;
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

/**
 * Remembers why WebGPU failed, with what was true then, in place of a preference for WebGL, and forgets the WebGPU
 * options saved for this browser. Returns the fallback saved, or null where storage refused it.
 */
function persistFallback(mode: "webgl2" | "webgl", reason: string, host: RendererBootstrapHost): RendererFallback | null {
  try {
    const { navigatorGpuPresent, isSecureContext } = host.diagnostics();
    const fallback: RendererFallback = { mode, reason, at: host.now(), navigatorGpuPresent, isSecureContext, userAgent: host.userAgent() };
    host.saveFallback(fallback);
    host.savePreference(null);
    host.saveVerification?.(null);
    return fallback;
  } catch { return null; /* persistence must not prevent a working backend */ }
}

/**
 * Saves the options the next start on the page's canvas tries, and reads them back. Where storage does not keep
 * them, a failure could not be remembered across a reload, which would then start the same way again.
 */
function rememberStart(options: WebGpuEngineOptions, host: RendererBootstrapHost): boolean {
  const verification: WebGpuVerification = { antialias: options.antialias, adaptToDeviceRatio: options.adaptToDeviceRatio,
    userAgent: host.userAgent(), at: host.now() };
  try {
    host.saveVerification?.(verification);
    const saved = host.readVerification?.() ?? null;
    return saved !== null && saved.antialias === verification.antialias && saved.adaptToDeviceRatio === verification.adaptToDeviceRatio
      && saved.userAgent === verification.userAgent && saved.at === verification.at;
  } catch { return false; }
}

/** Saves WebGL as the fallback for the next start, and reads it back, as rememberStart does. */
function rememberFallback(reason: string, host: RendererBootstrapHost): boolean {
  const fallback = persistFallback("webgl2", reason, host);
  if (!fallback) return false;
  try {
    const saved = host.readFallback();
    return saved !== null && saved.at === fallback.at && saved.reason === fallback.reason;
  } catch { return false; }
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
 * Starts WebGPU on the page's canvas without the probe, with options that presented in this browser before; the
 * probe costs several frames and a pause. If the canvas shows a presentation error in its first frames, the options
 * are forgotten and the page starts again, to probe and if need be fall back to WebGL, which this canvas can no
 * longer give.
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

/**
 * Starts WebGPU on the page's canvas in automatic mode without the probe, which would cost several frames and a
 * pause, and watches its first frames for the probe's errors instead. A failure cannot fall back on this canvas,
 * which can no longer give a WebGL context, so it saves what the next start tries, the safe options and then WebGL,
 * and starts the page again. Returns null where that could not be remembered, for the probe to decide.
 */
async function startWatchedWebGpu(
  canvas: HTMLCanvasElement,
  host: RendererBootstrapHost,
  diagnostics: RendererDiagnostics,
  antialias: boolean,
): Promise<{ renderer: RendererSelection; scene: Scene } | null> {
  if (!host.reload || !host.readVerification || !host.saveVerification) return null;
  const attempts: WebGpuEngineOptions[] = [{ ...DEFAULT_WEBGPU_OPTIONS, antialias }, SAFE_WEBGPU_OPTIONS];
  // Options saved by an earlier start were read back then, and have been kept since.
  let options = verifiedOptions(host, attempts);
  if (!options) {
    options = attempts[0]!;
    if (!rememberStart(options, host)) return null;
  }
  const next = attempts[attempts.indexOf(options) + 1];
  const engine = await createWebGpuEngine(canvas, options, host);
  watchWebGpuPresentation(engine, host.presentation, errors => {
    if (!(next ? rememberStart(next, host) : rememberFallback(errors[0] ?? "WebGPU presentation failed", host))) {
      host.report?.("warn", "[renderer] WebGPU cannot present on this page's canvas, and this browser keeps no record to start otherwise.", { errors });
      return;
    }
    host.report?.("warn", next
      ? "[renderer] WebGPU cannot present on this page's canvas. Starting again with antialias=false and adaptToDeviceRatio=false."
      : "[renderer] WebGPU cannot present on this device. Starting again with WebGL.", { errors });
    host.reload!();
  }, () => {
    persistWorkingRenderer("webgpu", host);
    try { host.saveFallback(null); } catch { /* persistence must not prevent a working backend */ }
  });
  return {
    renderer: { requested: "auto", mode: "webgpu", engine, diagnostics: { ...diagnostics, probeSkipped: true },
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

/** Whether the browser offers a WebGPU adapter: from the page's early request where it made one, or asked now. */
function webGpuSupport(host: RendererBootstrapHost): Promise<boolean> {
  let early: Promise<boolean> | null = null;
  try { early = host.earlyWebGpuSupport?.() ?? null; } catch { /* asked now */ }
  return early ?? WebGPUEngine.IsSupportedAsync;
}

async function tryWebGpuBootstrap(
  canvas: HTMLCanvasElement,
  host: RendererBootstrapHost,
  requested: RendererMode | "auto",
  diagnostics: RendererDiagnostics,
  antialias: boolean,
  probeFirst: boolean,
): Promise<{ renderer: RendererSelection; scene: Scene }> {
  try {
    const isSupported = await webGpuSupport(host);
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
    const watched = probeFirst ? null : await startWatchedWebGpu(canvas, host, diagnostics, antialias);
    return watched ?? await initializeWebGpuRenderer(canvas, host, requested, diagnostics, antialias);
  } catch (error) {
    const reason = getErrorMessage(error);
    host.report?.("warn", "[renderer] WebGPU initialization failed. Falling back to WebGL.", error);
    diagnostics.isSupportedAsyncResult ??= false;
    try {
      return createWebGlBootstrap(canvas, host, requested, antialias, reason, diagnostics);
    } catch (webGlError) {
      // WebGPU failed after it took the canvas, which then gives no WebGL context. Started again, the page uses WebGL.
      if (requested === "auto" && host.reload && rememberFallback(reason, host)) {
        host.report?.("warn", "[renderer] WebGL cannot start on a canvas WebGPU has used. Starting again with WebGL.", webGlError);
        host.reload();
      }
      throw webGlError;
    }
  }
}

/**
 * Pick a renderer and create the real runtime scene. In automatic mode WebGPU starts on the runtime canvas, and a
 * failure in its first frames is saved and the page started again (startWatchedWebGpu). With WebGPU chosen, after
 * a saved fallback, and where a failure could not be remembered, a probe on an offscreen canvas first verifies that
 * WebGPU can present, before the runtime canvas is touched.
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
    return tryWebGpuBootstrap(canvas, host, "webgpu", diagnostics, antialias, true);
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
  // WebGPU failed here before and may again, so the probe decides, rather than a failure that starts the page again.
  const retry = fallback !== null;
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
    }, antialias, retry);
  }

  return tryWebGpuBootstrap(canvas, host, "auto", getRendererDiagnostics(host, null), antialias, retry);
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
