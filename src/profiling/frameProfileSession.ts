import { FRAME_PROFILING_IDS } from "./ids.js";
import type { FrameProfiler, FrameTrace } from "./frameProfiler.js";

/** Structural public settings port; the one host UI registry satisfies it. */
export interface FrameProfileSettingsPort {
  get(id: string): unknown;
  watch(id: string, listener: () => void): () => void;
}

/**
 * One runtime's frame profiling: one profiler, one frame boundary, and one set
 * of Babylon observers and GPU timers that exist only while measuring is on.
 * The runtime closes each frame; hosts add their own sections to `profiler`.
 * Starting begins a fresh window, stopping detaches everything, and `dispose`
 * releases it for good.
 */
export interface FrameProfileSession {
  readonly profiler: FrameProfiler;
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  /** Resizes the summary window or the trace; either change starts afresh. */
  configure(options: { windowFrames?: number; traceFrames?: number }): void;
  /** The runtime's frame boundary: once per rendered frame, before any section of it. */
  frame(now?: number): void;
  /** Whether this renderer can time GPU work at all. */
  gpuTimed(): boolean;
  /**
   * What the GPU rows can say: `unsupported` when the renderer cannot time,
   * `waiting` until a reading arrives, `measuring` once one has.
   */
  gpuStatus(): GpuTimingStatus;
  trace(): FrameTrace;
  /** Called when measuring starts or stops, or the window or trace changes size. */
  onChange(listener: () => void): () => void;
  dispose(): void;
}

export type GpuTimingStatus = "unsupported" | "waiting" | "measuring";

export interface FrameProfileSessionOptions {
  /** The host's existing profiler, using the host's monotonic clock. */
  profiler: FrameProfiler;
  /** Attach the supplied device's measurements; no frame loop is started. */
  measure(profiler: FrameProfiler, gpuSection: string): () => void;
  /** Whether the supplied backend can provide GPU timing. */
  canTimeGpuFrames(): boolean;
  /** The GPU section, as `profileBabylonScene` names it. */
  gpuSection?: string;
}

export function createFrameProfileSession(options: FrameProfileSessionOptions): FrameProfileSession {
  const profiler = options.profiler;
  const gpuSection = options.gpuSection ?? "gpu/globe";
  const listeners = new Set<() => void>();
  let stopScene: (() => void) | null = null;
  let disposed = false;
  const notify = (): void => { for (const listener of [...listeners]) listener(); };

  const setEnabled = (enabled: boolean): void => {
    if (disposed) return;
    const changed = enabled !== profiler.enabled;
    profiler.enabled = enabled;
    if (enabled && !stopScene) stopScene = options.measure(profiler, gpuSection);
    if (!enabled && stopScene) {
      const stop = stopScene;
      stopScene = null;
      try { stop(); } finally { if (changed) notify(); }
      return;
    }
    if (changed) notify();
  };

  setEnabled(profiler.enabled);

  return {
    profiler,
    get enabled() {
      return profiler.enabled;
    },
    setEnabled,
    configure(next) {
      if (disposed) return;
      const before = [profiler.windowFrames, profiler.traceFrames];
      profiler.configure(next);
      if (before[0] !== profiler.windowFrames || before[1] !== profiler.traceFrames) notify();
    },
    frame: at => profiler.frame(at),
    gpuTimed: () => options.canTimeGpuFrames(),
    gpuStatus() {
      if (!options.canTimeGpuFrames()) return "unsupported";
      return profiler.summary().sections.some(section => section.section === gpuSection && section.activeFrames > 0) ? "measuring" : "waiting";
    },
    trace: () => profiler.trace(),
    onChange(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      try { setEnabled(false); }
      finally { disposed = true; listeners.clear(); }
    },
  };
}

/**
 * Drives the session from the `renderer.profiling.*` parameters, which the
 * app registers with `frameProfilingParameters`. Returns a function that stops.
 */
export function bindFrameProfileSettings(settings: FrameProfileSettingsPort, session: FrameProfileSession): () => void {
  let disposed = false;
  const stops: Array<() => void> = [];
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const failures: unknown[] = [];
    for (const stop of stops.splice(0)) {
      try { stop(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Frame profile settings cleanup failed.");
  };
  const read = (id: string): number => {
    const value = settings.get(id);
    return typeof value === "number" ? value : 0;
  };
  const apply = (): void => {
    if (disposed) return;
    session.configure({ windowFrames: read(FRAME_PROFILING_IDS.windowFrames), traceFrames: read(FRAME_PROFILING_IDS.traceFrames) });
    session.setEnabled(settings.get(FRAME_PROFILING_IDS.enabled) === true);
  };
  try {
    apply();
    for (const id of [FRAME_PROFILING_IDS.enabled, FRAME_PROFILING_IDS.windowFrames, FRAME_PROFILING_IDS.traceFrames]) stops.push(settings.watch(id, apply));
  } catch (error) {
    try { dispose(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Frame profile settings startup and cleanup failed.");
    }
    throw error;
  }
  return dispose;
}
