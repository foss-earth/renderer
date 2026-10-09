/** Host frame timestamps are milliseconds on one monotonic clock. */
export type RenderFrameCallback = (time: number) => void;

export interface RenderSchedulerOptions {
  /** Present one changed scene. Called inside the host animation frame. */
  tick(): void;
  /** Prepare hidden work using that same frame timestamp, without painting. */
  work?: (timeMs: number) => void;
  /** Only admitted runnable/in-flight work; capacity refusal waits for a wake. */
  shouldKeepWorking?: () => boolean;
  /** Keep presenting while the host's motion/inertia needs changed frames. */
  shouldKeepRendering?: () => boolean;
  /** Presentation interval in ms; work still runs on rate-capped host frames. */
  minFrameIntervalMs?: () => number;
  /** The host supplies its single asynchronous animation-frame authority. */
  requestFrame: (cb: RenderFrameCallback) => number;
  cancelFrame: (handle: number) => void;
}

/** Legacy structural ports are unchanged; existing host mocks need no new member. */
export interface RenderScheduler {
  requestRender(): void;
  beginContinuous(): void;
  endContinuous(): void;
  isContinuous(): boolean;
  setPaused(paused: boolean): void;
  stop(): void;
  isActive(): boolean;
  onActiveChange(listener: (active: boolean) => void): () => void;
}
export interface WorkRenderScheduler extends RenderScheduler {
  /** Schedule hidden preparation; does not request scene presentation. */
  requestWork(): void;
}

export function createRenderScheduler(options: RenderSchedulerOptions): WorkRenderScheduler {
  const { requestFrame, cancelFrame } = options;
  type Frame = { handle: number; generation: number; delivered: boolean };
  let pending: Frame | null = null;
  let registering = false;
  let inFrame = false;
  let continuousRefs = 0;
  let paused = false;
  let stopped = false;
  let renderRequested = false;
  let workRequested = false;
  let active = false;
  let lifecycleGeneration = 0;
  let activityGeneration = 0;
  let lastPresentedAt: number | null = null;
  const activeListeners = new Set<(active: boolean) => void>();
  const throwFailures = (failures: unknown[], message: string): void => {
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, message);
  };

  function setActive(next: boolean): void {
    if (active === next) return;
    active = next;
    const generation = ++activityGeneration;
    const failures: unknown[] = [];
    for (const listener of [...activeListeners]) {
      if (generation !== activityGeneration) break;
      if (!activeListeners.has(listener)) continue;
      try { listener(next); } catch (error) { failures.push(error); }
    }
    throwFailures(failures, "Scheduler activity notification failed.");
  }
  function live(generation: number): boolean {
    return !stopped && !paused && lifecycleGeneration === generation;
  }
  function schedule(): void {
    if (stopped || paused || pending || inFrame || registering) return;
    const frame: Frame = { handle: 0, generation: lifecycleGeneration, delivered: false };
    pending = frame; registering = true;
    const failures: unknown[] = [];
    try { frame.handle = requestFrame(time => runFrame(frame, time)); }
    catch (error) { if (pending === frame) pending = null; failures.push(error); }
    finally { registering = false; }
    if (frame.handle !== 0 && !frame.delivered && (pending !== frame || !live(frame.generation))) {
      // A supplied registration callback may reenter pause/stop before returning.
      try { cancelFrame(frame.handle); } catch (error) { failures.push(error); }
    }
    if (pending === frame && live(frame.generation)) {
      try { setActive(true); } catch (error) { failures.push(error); }
    } else if (!pending && !inFrame && !stopped && !paused && !frame.delivered) {
      try { setActive(false); } catch (error) { failures.push(error); }
    }
    throwFailures(failures, "Scheduler frame registration failed.");
  }
  function runFrame(frame: Frame, time: number): void {
    frame.delivered = true;
    if (pending !== frame || !live(frame.generation)) return;
    pending = null; inFrame = true;
    const generation = lifecycleGeneration;
    const failures: unknown[] = [];
    const wantsWork = workRequested || renderRequested || continuousRefs > 0;
    workRequested = false;
    try {
      if (wantsWork && options.work) {
        try { options.work(time); } catch (error) { failures.push(error); }
        if (!failures.length && live(generation) && options.shouldKeepWorking) {
          try { if (options.shouldKeepWorking()) workRequested = true; } catch (error) { failures.push(error); }
        }
      }
      if (!failures.length && live(generation) && (renderRequested || continuousRefs > 0)) {
        let interval = 0;
        try { interval = options.minFrameIntervalMs?.() ?? 0; } catch (error) { failures.push(error); }
        // The source jitter allowance remains presentation-only.
        if (!failures.length && live(generation) && !(interval > 0 && lastPresentedAt !== null && time - lastPresentedAt < interval - 1)) {
          lastPresentedAt = time; renderRequested = false;
          try { options.tick(); } catch (error) { failures.push(error); }
          if (!failures.length && live(generation)) {
            let keep = false;
            try { keep = continuousRefs > 0 || (options.shouldKeepRendering?.() ?? false); } catch (error) { failures.push(error); }
            if (!failures.length && live(generation) && (continuousRefs > 0 || keep)) renderRequested = true;
          }
        }
      }
    } catch (error) { failures.push(error); }
    finally {
      inFrame = false;
      // A failed callback does not silently paint/retry. The host chooses its
      // existing fatal/restart policy; explicit later requests can resume it.
      if (!failures.length && !stopped && !paused && (workRequested || renderRequested || continuousRefs > 0)) {
        try { schedule(); } catch (error) { failures.push(error); }
      } else {
        try { setActive(false); } catch (error) { failures.push(error); }
      }
    }
    throwFailures(failures, "Scheduler frame failed.");
  }

  return {
    requestWork(): void {
      if (stopped || paused) return;
      workRequested = true; schedule();
    },
    requestRender(): void {
      if (stopped) return;
      renderRequested = true; schedule();
    },
    beginContinuous(): void {
      if (stopped) return;
      continuousRefs += 1; renderRequested = true; schedule();
    },
    endContinuous(): void { if (continuousRefs > 0) continuousRefs -= 1; },
    isContinuous(): boolean { return continuousRefs > 0; },
    setPaused(next: boolean): void {
      if (stopped || next === paused) return;
      paused = next;
      const generation = ++lifecycleGeneration;
      workRequested = false; renderRequested = false;
      if (paused) {
        const frame = pending; pending = null;
        const failures: unknown[] = [];
        try { if (frame?.handle) cancelFrame(frame.handle); } catch (error) { failures.push(error); }
        if (lifecycleGeneration === generation && paused && !stopped) {
          try { setActive(false); } catch (error) { failures.push(error); }
        }
        throwFailures(failures, "Scheduler pause cleanup failed.");
      } else {
        // Preserve the source's first presentation on unpause, even when idle.
        renderRequested = true; schedule();
      }
    },
    stop(): void {
      stopped = true; lifecycleGeneration++;
      continuousRefs = 0; renderRequested = false; workRequested = false;
      const frame = pending; pending = null;
      const failures: unknown[] = [];
      try { if (frame?.handle) cancelFrame(frame.handle); } catch (error) { failures.push(error); }
      try { setActive(false); } catch (error) { failures.push(error); }
      finally { activeListeners.clear(); }
      throwFailures(failures, "Scheduler stop cleanup failed.");
    },
    isActive(): boolean { return active; },
    onActiveChange(listener): () => void {
      if (stopped) return () => undefined;
      activeListeners.add(listener);
      return () => { activeListeners.delete(listener); };
    },
  };
}
