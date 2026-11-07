/** Host frame timestamps are milliseconds on one monotonic clock. */
export type RenderFrameCallback = (time: number) => void;

export interface RenderSchedulerOptions {
  /** Present one changed scene. Called inside the host animation frame. */
  tick(): void;
  /**
   * Prepare hidden work using that same frame timestamp, without painting.
   * `presenting` says whether this frame also presents, as far as is known
   * before the work: work that the presentation does itself can wait for it.
   * Work may still ask for a presentation, which this frame then makes when
   * the presentation interval allows.
   */
  work?: (timeMs: number, frame?: WorkFrame) => void;
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

export interface WorkFrame {
  /** A presentation was asked for and the presentation interval allows it. */
  presenting: boolean;
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
  /**
   * Whether a presentation is asked for: a render request or a continuous
   * hold, while not paused or stopped. Unlike `onActiveChange`, it turns
   * false after the last asked-for frame even while work keeps frames
   * coming, so a host can tell when nothing more will be drawn.
   */
  isPresenting(): boolean;
  onPresentingChange(listener: (presenting: boolean) => void): () => void;
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
  let presenting = false;
  let presentingGeneration = 0;
  const activeListeners = new Set<(active: boolean) => void>();
  const presentingListeners = new Set<(presenting: boolean) => void>();
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
  /** Notifies a change in whether a presentation is asked for. */
  function syncPresenting(): void {
    const next = !stopped && !paused && (renderRequested || continuousRefs > 0);
    if (presenting === next) return;
    presenting = next;
    const generation = ++presentingGeneration;
    const failures: unknown[] = [];
    for (const listener of [...presentingListeners]) {
      if (generation !== presentingGeneration) break;
      if (!presentingListeners.has(listener)) continue;
      try { listener(next); } catch (error) { failures.push(error); }
    }
    throwFailures(failures, "Scheduler presentation notification failed.");
  }
  /** Outside its interval, a presentation would come too soon after the last. */
  function presentationDue(time: number, interval: number): boolean {
    return !(interval > 0 && lastPresentedAt !== null && time - lastPresentedAt < interval - 1);
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
        let presentingNow = false;
        if (renderRequested || continuousRefs > 0) {
          try { presentingNow = presentationDue(time, options.minFrameIntervalMs?.() ?? 0); } catch (error) { failures.push(error); }
        }
        if (!failures.length) { try { options.work(time, { presenting: presentingNow }); } catch (error) { failures.push(error); } }
        if (!failures.length && live(generation) && options.shouldKeepWorking) {
          try { if (options.shouldKeepWorking()) workRequested = true; } catch (error) { failures.push(error); }
        }
      }
      if (!failures.length && live(generation) && (renderRequested || continuousRefs > 0)) {
        let interval = 0;
        try { interval = options.minFrameIntervalMs?.() ?? 0; } catch (error) { failures.push(error); }
        // The source jitter allowance remains presentation-only.
        if (!failures.length && live(generation) && presentationDue(time, interval)) {
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
      const continues = !failures.length && !stopped && !paused && (workRequested || renderRequested || continuousRefs > 0);
      try { syncPresenting(); } catch (error) { failures.push(error); }
      if (continues) {
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
      renderRequested = true; syncPresenting(); schedule();
    },
    beginContinuous(): void {
      if (stopped) return;
      continuousRefs += 1; renderRequested = true; syncPresenting(); schedule();
    },
    endContinuous(): void { if (continuousRefs > 0) continuousRefs -= 1; },
    isPresenting(): boolean { return presenting; },
    onPresentingChange(listener): () => void {
      if (stopped) return () => undefined;
      presentingListeners.add(listener);
      return () => { presentingListeners.delete(listener); };
    },
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
        try { syncPresenting(); } catch (error) { failures.push(error); }
        if (lifecycleGeneration === generation && paused && !stopped) {
          try { setActive(false); } catch (error) { failures.push(error); }
        }
        throwFailures(failures, "Scheduler pause cleanup failed.");
      } else {
        // Preserve the source's first presentation on unpause, even when idle.
        renderRequested = true; syncPresenting(); schedule();
      }
    },
    stop(): void {
      stopped = true; lifecycleGeneration++;
      continuousRefs = 0; renderRequested = false; workRequested = false;
      const frame = pending; pending = null;
      const failures: unknown[] = [];
      try { if (frame?.handle) cancelFrame(frame.handle); } catch (error) { failures.push(error); }
      try { syncPresenting(); } catch (error) { failures.push(error); }
      finally { presentingListeners.clear(); }
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
