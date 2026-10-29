import type { Scene } from "@babylonjs/core";
import { DynamicResolutionController, DYNAMIC_RESOLUTION_UNTIMED_NOTE } from "../dynamicResolution.js";
import type { RenderScheduler } from "../renderScheduler.js";
import type { RendererResourceLifecycle } from "../resourceLifecycle.js";
import type { ReadinessPolicy, ReadinessTimers } from "../readiness.js";
import { resolveSpatialUpscalingState } from "../spatialUpscaling.js";
import type { RendererSelection } from "./createRendererMode.js";
import { createSceneUpdates } from "./sceneUpdates.js";
import { createPresentationCandidates } from "./presentationCandidates.js";
import { acquireGpuFrameTime, canTimeGpuFrames, type GpuFrameTimeLease } from "./frameProfiler.js";
import { createSpatialUpscalingPasses, type SpatialUpscalingPasses } from "./spatialUpscalingPostProcess.js";

export interface RendererPlatformPort {
  devicePixelRatio(): number;
  isHidden(): boolean;
  onResize(listener: () => void): () => void;
  onVisibilityChange(listener: () => void): () => void;
}

/** Minimal host settings port; compatible with the public UI registry. */
export interface RendererSettingsPort {
  get(id: string): unknown;
  has(id: string): boolean;
  watch(id: string, listener: (value: unknown) => void): () => void;
  setDeviceContext(context: { rendererMode: string; maxTextureSize: number | null; rendererDevicePixels: boolean | null }): void;
  setNote(id: string, note: string | null): void;
}

export interface BabylonRendererLifecycleOptions {
  renderer: RendererSelection;
  scene: Scene;
  /** An existing host scheduler. This lifecycle never constructs or stops another one. */
  scheduler: RenderScheduler;
  settings: RendererSettingsPort;
  platform: RendererPlatformPort;
  isPreparingFrame(): boolean;
  /** The host's presentation layer; no navigation implementation is imported. */
  presentationLayer: number;
  /** Engine owns geospatial camera clipping. Called on its saved Renderer settings changes. */
  applyClipping?(): void;
  /** End host navigation/feature leases before notifying device-loss subscribers. */
  onDeviceLost?(): void;
  /** Optional resource scope to retire on device loss; readiness stays generation-gated. */
  resources?: RendererResourceLifecycle;
  timers?: ReadinessTimers;
  readinessPolicy?: ReadinessPolicy;
}

export interface BabylonRendererLifecycle {
  getDeviceGeneration(): number;
  onDeviceLost(listener: () => void): () => void;
  onDeviceRestored(listener: () => void): () => void;
  applyResolutionScale(): void;
  /** Bracket a host-prepared frame, preserving WebGPU presentation without runRenderLoop. */
  renderFrame(prepare?: () => void, afterRender?: () => void): void;
  /** Detach before host scheduler/scene/device teardown; supplied objects remain host-owned. */
  dispose(): void;
}

/** Renderer-only pieces of the old mixed runtime, over the same supplied authorities. */
export function createBabylonRendererLifecycle(options: BabylonRendererLifecycleOptions): BabylonRendererLifecycle {
  const { renderer, scene, scheduler, settings, platform } = options;
  let disposed = false;
  let deviceLost = false;
  let deviceGeneration = 0;
  const lost = new Set<() => void>();
  const restored = new Set<() => void>();
  const stops: Array<() => void> = [];
  let candidates: ReturnType<typeof createPresentationCandidates> | undefined;
  let updates: ReturnType<typeof createSceneUpdates> | undefined;
  let passes: SpatialUpscalingPasses | undefined;
  let governor: DynamicResolutionController | null = null;
  let gpuLease: GpuFrameTimeLease | null = null;
  let lastCpuMs = 0;
  let resizeIgnore = 0;
  let appliedLevel = Number.NaN;
  const clock = (): number => {
    const now = globalThis.performance?.now;
    return typeof now === "function" ? now.call(globalThis.performance) : Date.now();
  };
  const manualScale = (): number => {
    const scale = settings.get("renderer.resolutionScale");
    return typeof scale === "number" && scale > 0 ? scale : 1;
  };
  const settingNumber = (id: string, fallback: number): number => {
    if (!settings.has(id)) return fallback;
    const value = settings.get(id);
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const releaseGovernor = (): void => {
    gpuLease?.release();
    gpuLease = null;
    governor = null;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    for (const stop of [...stops.splice(0), () => updates?.dispose(), () => candidates?.dispose()]) {
      try { stop(); } catch (error) { failures.push(error); }
    }
    lost.clear(); restored.clear();
    if (failures.length) throw new AggregateError(failures, "Renderer lifecycle cleanup failed.");
  };
  const applyCandidates = (): void => {
    if (disposed) return;
    candidates!.setEnabled(settings.has("renderer.experiments.presentationCandidates") && settings.get("renderer.experiments.presentationCandidates") === true);
  };
  const syncGovernor = (): void => {
    const enabled = settings.has("renderer.dynamicResolution") && settings.get("renderer.dynamicResolution") === true;
    if (!enabled || !canTimeGpuFrames(renderer.engine)) {
      releaseGovernor();
      if (settings.has("renderer.dynamicResolution")) settings.setNote("renderer.dynamicResolution", enabled ? DYNAMIC_RESOLUTION_UNTIMED_NOTE : null);
      return;
    }
    if (settings.has("renderer.dynamicResolution")) settings.setNote("renderer.dynamicResolution", null);
    const maxScale = manualScale();
    const minScale = Math.min(0.5, maxScale);
    const target = settingNumber("renderer.targetFps", 60);
    const targetFps = target > 0 ? target : 60;
    if (!governor) {
      governor = new DynamicResolutionController({ minScale, maxScale, targetFps });
      gpuLease = acquireGpuFrameTime(renderer.engine);
    } else {
      governor.setLimits(minScale, maxScale);
      governor.setTargetFps(targetFps);
    }
  };
  const applyPresentation = (): void => {
    if (disposed) return;
    syncGovernor();
    const scale = governor ? governor.scale : manualScale();
    const sharpness = settingNumber("renderer.upscalingSharpness", 0.2);
    const state = resolveSpatialUpscalingState({
      mode: settings.has("renderer.upscaling") && typeof settings.get("renderer.upscaling") === "string" ? String(settings.get("renderer.upscaling")) : "off",
      sharpness,
      effectiveRenderScale: scale,
      backend: renderer.mode,
    });
    if (settings.has("renderer.upscaling")) settings.setNote("renderer.upscaling", state.unavailableReason);
    const dpr = platform.devicePixelRatio() || 1;
    const level = 1 / (state.active ? dpr : dpr * scale);
    // Remember the level we asked for. setHardwareScalingLevel always resizes,
    // and that resize can rewrite the level the engine reports back.
    if (!(Math.abs(appliedLevel - level) <= 1e-6)) {
      appliedLevel = level;
      renderer.engine.setHardwareScalingLevel(level);
    }
    passes?.sync({ easu: state.easu, rcas: state.rcas, attenuation: state.attenuation, renderScale: scale });
  };
  const applyResolutionScale = (): void => { if (!disposed) applyPresentation(); };
  const steer = (): void => {
    if (disposed || !governor || !gpuLease) return;
    const ignore = platform.isHidden() || resizeIgnore > 0;
    if (resizeIgnore > 0) resizeIgnore -= 1;
    const before = governor.scale;
    governor.observe({ gpuMs: gpuLease.read(), cpuMs: lastCpuMs, ignore });
    if (governor.scale !== before) applyPresentation();
  };
  try {
    candidates = createPresentationCandidates(scene, options.presentationLayer);
    applyCandidates();
    settings.setDeviceContext({
      rendererMode: renderer.mode,
      maxTextureSize: (renderer.engine.getCaps() as { maxTextureSize?: number }).maxTextureSize ?? null,
      rendererDevicePixels: renderer.devicePixels ?? null,
    });
    if (renderer.antialias === false && settings.get("renderer.antialias") !== false) settings.setNote("renderer.antialias", "Off: WebGPU could only start without it on this device.");
    passes = createSpatialUpscalingPasses(scene, renderer.engine);
    stops.push(() => passes?.dispose());
    stops.push(releaseGovernor);
    applyResolutionScale();
    updates = createSceneUpdates({ scene, requestRender: scheduler.requestRender, isPreparingFrame: options.isPreparingFrame, timers: options.timers, readinessPolicy: options.readinessPolicy });
    stops.push(scheduler.onActiveChange(active => {
      if (disposed) return;
      if (active) updates!.cancelSettle();
      else if (!deviceLost && !platform.isHidden()) updates!.settle();
    }));
    const onPresentationChange = (): void => { if (disposed) return; applyResolutionScale(); renderer.engine.resize(); scheduler.requestRender(); };
    stops.push(settings.watch("renderer.resolutionScale", onPresentationChange));
    stops.push(settings.watch("renderer.frameRateCap", () => { if (!disposed) scheduler.requestRender(); }));
    if (settings.has("renderer.experiments.presentationCandidates")) stops.push(settings.watch("renderer.experiments.presentationCandidates", () => { if (disposed) return; applyCandidates(); scheduler.requestRender(); }));
    if (options.applyClipping) for (const id of ["renderer.clipping", "renderer.clipping.fixed"]) stops.push(settings.watch(id, () => { if (disposed) return; options.applyClipping!(); scheduler.requestRender(); }));
    for (const id of ["renderer.upscaling", "renderer.upscalingSharpness", "renderer.dynamicResolution", "renderer.targetFps"]) {
      if (settings.has(id)) stops.push(settings.watch(id, onPresentationChange));
    }
    stops.push(platform.onResize(() => { if (disposed) return; resizeIgnore = 3; applyResolutionScale(); renderer.engine.resize(); scheduler.requestRender(); }));
    stops.push(platform.onVisibilityChange(() => { if (!disposed) scheduler.setPaused(platform.isHidden()); }));
    const lostObserver = renderer.engine.onContextLostObservable.add(() => {
      if (disposed) return;
      deviceLost = true;
      deviceGeneration += 1;
      const failures: unknown[] = [];
      for (const action of [() => passes?.suspend(), () => updates!.cancelSettle(), options.onDeviceLost, () => options.resources?.invalidate(), ...lost]) {
        try { action?.(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Renderer device-loss cleanup failed.");
    });
    stops.push(() => renderer.engine.onContextLostObservable.remove(lostObserver));
    const restoredObserver = renderer.engine.onContextRestoredObservable.add(() => {
      if (disposed) return;
      deviceLost = false;
      const failures: unknown[] = [];
      try { passes?.resume(); } catch (error) { failures.push(error); }
      for (const listener of [...restored]) {
        if (disposed) break;
        if (!restored.has(listener)) continue;
        try { listener(); } catch (error) { failures.push(error); }
      }
      // A failed subscriber cannot skip peers or mask their errors with a later
      // request. A subscriber may also end this borrowed binding synchronously.
      if (!disposed) { try { scheduler.requestRender(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, "Renderer device restoration failed.");
    });
    stops.push(() => renderer.engine.onContextRestoredObservable.remove(restoredObserver));
    return {
      getDeviceGeneration: () => deviceGeneration,
      onDeviceLost(listener) { if (disposed) return () => undefined; lost.add(listener); return () => { lost.delete(listener); }; },
      onDeviceRestored(listener) { if (disposed) return () => undefined; restored.add(listener); return () => { restored.delete(listener); }; },
      applyResolutionScale,
      renderFrame(prepare, afterRender) {
        if (disposed || deviceLost) return;
        steer();
        updates!.cancelSettle();
        renderer.engine.beginFrame();
        const failures: unknown[] = [];
        const cpuStarted = clock();
        try { prepare?.(); scene.render(); } catch (error) { failures.push(error); }
        lastCpuMs = clock() - cpuStarted;
        // Only a successfully begun frame is ended, exactly once. Preserve the
        // preparation/render failure if the native end also throws afterward.
        try { renderer.engine.endFrame(); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Renderer frame and completion failed.");
        afterRender?.();
      },
      dispose,
    };
  } catch (error) {
    try { dispose(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Renderer lifecycle startup and cleanup failed.");
    }
    throw error;
  }
}
