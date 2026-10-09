import { EngineInstrumentation, type AbstractEngine, type Observable, type Scene, type WebGPUEngine } from "@babylonjs/core";
import type { FrameProfiler } from "../profiling/frameProfiler.js";

/**
 * Times Babylon's scene render on the CPU, with its main phases underneath,
 * and the GPU's frame when the engine can time it: WebGPU needs the
 * "timestamp-query" feature on its device, WebGL the disjoint timer query
 * extension. Returns a function that stops the measuring.
 */
export function profileBabylonScene(
  profiler: FrameProfiler,
  scene: Scene,
  engine: AbstractEngine,
  { section = "render", gpuSection = "gpu/globe" }: { section?: string; gpuSection?: string } = {},
): () => void {
  const phases: [string, Observable<Scene>, Observable<Scene>][] = [
    [section, scene.onBeforeAnimationsObservable, scene.onAfterRenderObservable],
    [`${section}/active meshes`, scene.onBeforeActiveMeshesEvaluationObservable, scene.onAfterActiveMeshesEvaluationObservable],
    [`${section}/render targets`, scene.onBeforeRenderTargetsRenderObservable, scene.onAfterRenderTargetsRenderObservable],
    [`${section}/draw`, scene.onBeforeDrawPhaseObservable, scene.onAfterDrawPhaseObservable],
  ];
  const detach: (() => void)[] = [];
  for (const [name, before, after] of phases) {
    let startedAt: number | null = null;
    const onBefore = (): void => { startedAt = profiler.clock(); };
    const onAfter = (): void => { if (startedAt !== null) profiler.add(name, startedAt); startedAt = null; };
    const beforeObserver = before.add(onBefore);
    const afterObserver = after.add(onAfter);
    detach.push(() => {
      before.remove(beforeObserver);
      after.remove(afterObserver);
    });
  }

  // GPU readings arrive frames late, and on WebGL Babylon times only one frame
  // in every few. The latest reading stands for every frame until the next
  // arrives, so the mean is per frame rather than per reading.
  const gpu: GpuTimer = isWebGpuEngine(engine) ? webGpuPassTimer(engine)
    : canTimeGpuFrames(engine) ? webGlFrameTimer(engine)
    : { read: () => 0, dispose() {} };
  const gpuObserver = scene.onAfterRenderObservable.add(() => {
    const milliseconds = gpu.read(profiler.enabled);
    if (milliseconds > 0) profiler.addDuration(gpuSection, milliseconds);
  });
  detach.push(() => {
    scene.onAfterRenderObservable.remove(gpuObserver);
    gpu.dispose();
  });
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    const failures: unknown[] = [];
    for (const stop of detach) { try { stop(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "Frame measurement cleanup failed.");
  };
}

interface GpuTimer {
  /** Switches timing to match `enabled`; while on, the latest per-frame reading in milliseconds, or 0 before the first. */
  read(enabled: boolean): number;
  dispose(): void;
}

function isWebGpuEngine(engine: AbstractEngine): engine is WebGPUEngine {
  return "enableGPUTimingMeasurements" in engine;
}

/**
 * WebGPU: Babylon's frame-level timer writes timestamps on the command
 * encoder, which browsers no longer allow, so it always reads 0. Its per-pass
 * timer uses the render passes' `timestampWrites` and works. Every pass that
 * has no counter of its own lands in the main pass's counter, so the reading is
 * the GPU time of all the frame's render passes; copies and mipmap generation
 * are left out.
 */
function webGpuPassTimer(engine: WebGPUEngine): GpuTimer {
  let owned = false;
  let seenTotal = 0;
  let seenFrames = 0;
  let held = 0;
  const stop = (): void => {
    if (owned) engine.enableGPUTimingMeasurements = false;
    owned = false;
    held = 0;
  };
  return {
    read(enabled) {
      if (!enabled) {
        stop();
        return 0;
      }
      if (!engine.enableGPUTimingMeasurements) {
        engine.enableGPUTimingMeasurements = true;
        owned = true;
        seenTotal = 0;
        seenFrames = 0;
      }
      const counter = engine.gpuTimeInFrameForMainPass?.counter;
      if (!counter) return 0;
      // The counter's newest frame may still be collecting its passes; the ones before it are complete.
      const frames = Math.max(0, counter.count - 1);
      if (frames > seenFrames) {
        held = (counter.total - seenTotal) / (frames - seenFrames) / 1e6;
        seenTotal = counter.total;
        seenFrames = frames;
      }
      return held;
    },
    dispose: stop,
  };
}

/** WebGL: the disjoint timer query times whole frames, one in every few. */
function webGlFrameTimer(engine: AbstractEngine): GpuTimer {
  let instrumentation: EngineInstrumentation | null = null;
  return {
    read(enabled) {
      if (!enabled) {
        if (instrumentation) instrumentation.captureGPUFrameTime = false;
        return 0;
      }
      if (!instrumentation) instrumentation = new EngineInstrumentation(engine);
      if (!instrumentation.captureGPUFrameTime) instrumentation.captureGPUFrameTime = true;
      return instrumentation.gpuFrameTimeCounter.current / 1e6;
    },
    dispose: () => instrumentation?.dispose(),
  };
}

/** Whether this engine can time the GPU's frame, so a report can say why a GPU row is missing. */
export function canTimeGpuFrames(engine: AbstractEngine): boolean {
  const caps = engine.getCaps() as { timerQuery?: unknown; timestampQuery?: unknown };
  return Boolean(caps.timerQuery || caps.timestampQuery);
}
