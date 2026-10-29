import { EngineInstrumentation, type AbstractEngine, type Observable, type Scene, type WebGPUEngine } from "@babylonjs/core";
// The WebGL engine's GPU frame timer, which EngineInstrumentation calls; the WebGPU engine brings its own.
import "@babylonjs/core/Engines/Extensions/engine.query.js";
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
  const gpu: GpuTimer = isWebGpuEngine(engine) || canTimeGpuFrames(engine) ? leasedTimer(engine)
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

interface GpuLeaseRecord {
  refs: number;
  kind: "webgpu" | "webgl" | "none";
  instrumentation: EngineInstrumentation | null;
}

interface GpuLeaseReader {
  primed: boolean;
  seenTotal: number;
  seenFrames: number;
  held: number;
}

const gpuLeases = new WeakMap<object, GpuLeaseRecord>();

export interface GpuFrameTimeLease {
  /** Latest completed GPU frame, in milliseconds, or 0 before one exists. */
  read(): number;
  release(): void;
}

/**
 * Reference-counted GPU timing for one engine. The profiler's pass timer and
 * dynamic resolution both hold a lease: timing stays on until the last one
 * releases, so turning the profiler off cannot blind the scaler.
 */
export function acquireGpuFrameTime(engine: AbstractEngine): GpuFrameTimeLease {
  const key = engine as object;
  let record = gpuLeases.get(key);
  if (!record) {
    record = { refs: 0, kind: isWebGpuEngine(engine) ? "webgpu" : canTimeGpuFrames(engine) ? "webgl" : "none", instrumentation: null };
    gpuLeases.set(key, record);
  }
  const leaseRecord = record;
  leaseRecord.refs += 1;
  enableGpuTiming(engine, leaseRecord);
  const reader: GpuLeaseReader = { primed: false, seenTotal: 0, seenFrames: 0, held: 0 };
  let released = false;
  return {
    read() {
      if (released) return 0;
      if (leaseRecord.kind === "webgpu") return readWebGpuPass(engine as WebGPUEngine, reader);
      if (leaseRecord.kind === "webgl") return readWebGlFrame(leaseRecord);
      return 0;
    },
    release() {
      if (released) return;
      released = true;
      leaseRecord.refs = Math.max(0, leaseRecord.refs - 1);
      if (leaseRecord.refs === 0) {
        disableGpuTiming(engine, leaseRecord);
        gpuLeases.delete(key);
      }
    },
  };
}

function enableGpuTiming(engine: AbstractEngine, record: GpuLeaseRecord): void {
  if (record.kind === "webgpu" && isWebGpuEngine(engine)) {
    if (!engine.enableGPUTimingMeasurements) engine.enableGPUTimingMeasurements = true;
    return;
  }
  if (record.kind !== "webgl") return;
  if (!record.instrumentation) record.instrumentation = new EngineInstrumentation(engine);
  if (!record.instrumentation.captureGPUFrameTime) record.instrumentation.captureGPUFrameTime = true;
}

function disableGpuTiming(engine: AbstractEngine, record: GpuLeaseRecord): void {
  if (record.kind === "webgpu" && isWebGpuEngine(engine)) engine.enableGPUTimingMeasurements = false;
  if (record.instrumentation) {
    record.instrumentation.captureGPUFrameTime = false;
    record.instrumentation.dispose();
    record.instrumentation = null;
  }
}

/**
 * WebGPU's per-pass timer writes `timestampWrites` on render passes. Passes
 * without a counter of their own land in the main pass, so the reading is the
 * GPU time of the frame's render passes. The newest frame may still be open;
 * the ones before it are complete.
 */
function readWebGpuPass(engine: WebGPUEngine, reader: GpuLeaseReader): number {
  const counter = engine.gpuTimeInFrameForMainPass?.counter;
  if (!counter) return 0;
  const frames = Math.max(0, counter.count - 1);
  if (!reader.primed || frames < reader.seenFrames || counter.total < reader.seenTotal) {
    reader.primed = true;
    reader.seenTotal = counter.total;
    reader.seenFrames = frames;
    reader.held = 0;
    return 0;
  }
  if (frames > reader.seenFrames) {
    reader.held = (counter.total - reader.seenTotal) / (frames - reader.seenFrames) / 1e6;
    reader.seenTotal = counter.total;
    reader.seenFrames = frames;
  }
  return reader.held;
}

function readWebGlFrame(record: GpuLeaseRecord): number {
  const counter = record.instrumentation?.gpuFrameTimeCounter;
  return counter ? counter.current / 1e6 : 0;
}

function leasedTimer(engine: AbstractEngine): GpuTimer {
  let lease: GpuFrameTimeLease | null = null;
  const stop = (): void => {
    lease?.release();
    lease = null;
  };
  return {
    read(enabled) {
      if (!enabled) {
        stop();
        return 0;
      }
      lease ??= acquireGpuFrameTime(engine);
      return lease.read();
    },
    dispose: stop,
  };
}

/** Whether this engine can time the GPU's frame, so a report can say why a GPU row is missing. */
export function canTimeGpuFrames(engine: AbstractEngine): boolean {
  const caps = engine.getCaps() as { timerQuery?: unknown; timestampQuery?: unknown };
  return Boolean(caps.timerQuery || caps.timestampQuery);
}
