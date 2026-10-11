import type { RenderSchedulerOptions } from "./renderScheduler.js";

/** Structural cancellation keeps the core declaration usable without DOM libs. */
export interface BorrowedFrameSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** Extracted from Earth App runtimeComposition; no feature/device is constructed. */
export interface BorrowedFrameClosureOptions {
  presentation(): { renderFrame(prepare: () => void, rendered: () => void): void } | undefined;
  prepareFrame(nowMs: number): void;
  afterFrame(nowMs: number, rendered: boolean): void;
  shouldKeepRendering(): boolean;
  minFrameIntervalMs(): number;
  stopScheduler(): void;
  onFrameError(error: unknown): void;
  resourceWork?: { prepare(nowMs: number): void };
  /** Bindings/features only. The borrowed device must outlive whenSettled(). */
  cleanup: readonly (() => void)[];
  /** Actual owner drains, invoked after cancellation/cleanup and frame closure. */
  whenOwnersSettled?: readonly (() => Promise<void>)[];
  signal?: BorrowedFrameSignal;
}
export interface BorrowedFrameClosure {
  /** Supply these callbacks to the host's ONE createRenderScheduler call. */
  schedulerOptions(frames: Pick<RenderSchedulerOptions, "requestFrame" | "cancelFrame">): RenderSchedulerOptions;
  readonly inFrame: boolean;
  readonly disposed: boolean;
  /** Begins cancellation immediately; cleanup waits for the current frame to close. */
  dispose(): void;
  whenSettled(): Promise<void>;
}

export function attemptNativeCleanup(actions: readonly (() => void)[], message: string): void {
  const errors: unknown[] = [];
  for (const action of actions) { try { action(); } catch (error) { errors.push(error); } }
  if (errors.length) throw new AggregateError(errors, message);
}

export function createBorrowedFrameClosure(options: BorrowedFrameClosureOptions): BorrowedFrameClosure {
  let disposed = false, cleaned = false, inFrame = false, frameAt = 0;
  let drain: Promise<void> | undefined;
  const failures: unknown[] = [];
  const waiters = new Set<{ resolve(): void; reject(error: unknown): void }>();
  const cancelledFrame = new Error("Borrowed frame was cancelled during preparation.");
  const notify = (error?: unknown): void => {
    for (const waiter of waiters) { if (error !== undefined) waiter.reject(error); else waiter.resolve(); }
    waiters.clear();
  };
  const cleanup = (): void => {
    if (cleaned || inFrame || !disposed) return;
    cleaned = true;
    for (const action of [...options.cleanup, () => options.signal?.removeEventListener("abort", abort)]) {
      try { action(); } catch (error) { failures.push(error); }
    }
    // Invoke every drain even when an earlier cleanup/drain fails.
    drain = (async () => {
      const results = await Promise.allSettled((options.whenOwnersSettled ?? []).map(async settle => { await settle(); }));
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, "Borrowed frame retirement failed.");
    })();
    void drain.then(() => notify(), error => { notify(error); });
    if (failures.length) throw new AggregateError(failures, "Borrowed frame cleanup failed.");
  };
  const dispose = (): void => { disposed = true; cleanup(); };
  const abort = (): void => { try { dispose(); } catch (error) {
    try { options.onFrameError(error); } catch (reporting) { failures.push(reporting); }
  } };
  const report = (errors: unknown[], message: string): void => {
    if (!errors.length) return;
    try { options.stopScheduler(); } catch (error) { errors.push(error); }
    try { options.onFrameError(errors.length === 1 ? errors[0] : new AggregateError(errors, message)); }
    catch (reporting) { failures.push(reporting); }
  };
  const close = (errors: unknown[]): void => {
    inFrame = false;
    if (disposed) { try { cleanup(); } catch (error) { errors.push(error); } }
    else notify();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  return {
    get inFrame() { return inFrame; }, get disposed() { return disposed; },
    schedulerOptions(frames) {
      return {
        requestFrame: callback => frames.requestFrame(time => { frameAt = time; callback(time); }),
        cancelFrame: handle => frames.cancelFrame(handle),
        shouldKeepRendering: () => !disposed && options.shouldKeepRendering(),
        minFrameIntervalMs: () => options.minFrameIntervalMs(),
        work(timeMs) {
          if (disposed || !options.resourceWork) return;
          inFrame = true;
          const errors: unknown[] = [];
          try { options.resourceWork.prepare(timeMs); } catch (error) { errors.push(error); }
          finally { close(errors); }
          report(errors, "Borrowed resource work failed.");
        },
        tick() {
          const presentation = options.presentation();
          if (disposed || !presentation) return;
          inFrame = true;
          let rendered = false;
          const errors: unknown[] = [];
          try {
            presentation.renderFrame(() => {
              options.prepareFrame(frameAt);
              if (disposed) throw cancelledFrame;
            }, () => { rendered = true; });
          } catch (error) { if (error !== cancelledFrame) errors.push(error); }
          try { options.afterFrame(frameAt, rendered); } catch (error) { errors.push(error); }
          finally { close(errors); }
          report(errors, "Borrowed frame and bookkeeping failed.");
        },
      };
    },
    dispose,
    whenSettled() {
      if (drain) return drain;
      return new Promise<void>((resolve, reject) => {
        if (!inFrame && !disposed) resolve();
        else waiters.add({ resolve, reject });
      });
    },
  };
}
