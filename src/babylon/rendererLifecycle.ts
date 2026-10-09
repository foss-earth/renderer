import type { Scene } from "@babylonjs/core";
import type { RenderScheduler } from "../renderScheduler.js";
import type { RendererResourceLifecycle } from "../resourceLifecycle.js";
import type { ReadinessPolicy, ReadinessTimers } from "../readiness.js";
import type { RendererSelection } from "./createRendererMode.js";
import { createSceneUpdates } from "./sceneUpdates.js";
import { createPresentationCandidates } from "./presentationCandidates.js";

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
  let deviceGeneration = 0;
  const lost = new Set<() => void>();
  const restored = new Set<() => void>();
  const stops: Array<() => void> = [];
  let candidates: ReturnType<typeof createPresentationCandidates> | undefined;
  let updates: ReturnType<typeof createSceneUpdates> | undefined;
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
  const applyResolutionScale = (): void => {
    if (disposed) return;
    const scale = settings.get("renderer.resolutionScale");
    const ratio = (platform.devicePixelRatio() || 1) * (typeof scale === "number" && scale > 0 ? scale : 1);
    renderer.engine.setHardwareScalingLevel(1 / ratio);
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
    applyResolutionScale();
    updates = createSceneUpdates({ scene, requestRender: scheduler.requestRender, isPreparingFrame: options.isPreparingFrame, timers: options.timers, readinessPolicy: options.readinessPolicy });
    stops.push(scheduler.onActiveChange(active => {
      if (disposed) return;
      if (active) updates!.cancelSettle();
      else if (!platform.isHidden()) updates!.settle();
    }));
    stops.push(settings.watch("renderer.resolutionScale", () => { if (disposed) return; applyResolutionScale(); renderer.engine.resize(); scheduler.requestRender(); }));
    stops.push(settings.watch("renderer.frameRateCap", () => { if (!disposed) scheduler.requestRender(); }));
    if (settings.has("renderer.experiments.presentationCandidates")) stops.push(settings.watch("renderer.experiments.presentationCandidates", () => { if (disposed) return; applyCandidates(); scheduler.requestRender(); }));
    if (options.applyClipping) for (const id of ["renderer.clipping", "renderer.clipping.fixed"]) stops.push(settings.watch(id, () => { if (disposed) return; options.applyClipping!(); scheduler.requestRender(); }));
    stops.push(platform.onResize(() => { if (disposed) return; applyResolutionScale(); renderer.engine.resize(); scheduler.requestRender(); }));
    stops.push(platform.onVisibilityChange(() => { if (!disposed) scheduler.setPaused(platform.isHidden()); }));
    const lostObserver = renderer.engine.onContextLostObservable.add(() => {
      if (disposed) return;
      deviceGeneration += 1;
      const failures: unknown[] = [];
      for (const action of [options.onDeviceLost, () => options.resources?.invalidate(), ...lost]) {
        try { action?.(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Renderer device-loss cleanup failed.");
    });
    stops.push(() => renderer.engine.onContextLostObservable.remove(lostObserver));
    const restoredObserver = renderer.engine.onContextRestoredObservable.add(() => {
      if (disposed) return;
      const failures: unknown[] = [];
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
        if (disposed) return;
        updates!.cancelSettle();
        renderer.engine.beginFrame();
        const failures: unknown[] = [];
        try { prepare?.(); scene.render(); } catch (error) { failures.push(error); }
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
