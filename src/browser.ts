import { createRenderScheduler, type WorkRenderScheduler, type RenderSchedulerOptions, type RenderFrameCallback } from "./renderScheduler.js";
import type { ResourceTimingEntry } from "./profiling/networkSource.js";

export interface AnimationFrameHost {
  requestAnimationFrame(callback: RenderFrameCallback): number;
  cancelAnimationFrame(handle: number): void;
}

/** Source-compatible optional frame ports, isolated from the pure core. */
export interface BrowserRenderSchedulerOptions extends Omit<RenderSchedulerOptions, "requestFrame" | "cancelFrame"> {
  requestFrame?: RenderSchedulerOptions["requestFrame"];
  cancelFrame?: RenderSchedulerOptions["cancelFrame"];
  host?: AnimationFrameHost;
}

/** Creates exactly one core scheduler. Browser globals are read only when called. */
export function createBrowserRenderScheduler(options: BrowserRenderSchedulerOptions): WorkRenderScheduler {
  const host = options.host ?? globalThis as unknown as Partial<AnimationFrameHost>;
  if ((!options.requestFrame && !host.requestAnimationFrame) || (!options.cancelFrame && !host.cancelAnimationFrame)) {
    throw new Error("Supply animation-frame ports or call this browser adapter in an animation-frame host.");
  }
  return createRenderScheduler({
    ...options,
    requestFrame: options.requestFrame ?? (callback => host.requestAnimationFrame!(callback)),
    cancelFrame: options.cancelFrame ?? (handle => host.cancelAnimationFrame!(handle)),
  });
}

export interface ResourceTimingHost {
  PerformanceObserver?: new (callback: (list: { getEntries(): readonly unknown[] }) => void) => {
    observe(options: { type: string; buffered?: boolean }): void;
    disconnect(): void;
  };
}

/**
 * The page's requests as they finish, for `createNetworkSource`: an observer
 * exists only between its start and stop. The global is read only when called.
 */
export function observeResourceTiming(host: ResourceTimingHost = globalThis as ResourceTimingHost) {
  return (listener: (entries: readonly ResourceTimingEntry[]) => void): (() => void) => {
    const Observer = host.PerformanceObserver;
    if (!Observer) return () => undefined;
    // Observing only "resource" entries, every entry is a PerformanceResourceTiming.
    const observer = new Observer(list => listener(list.getEntries() as readonly ResourceTimingEntry[]));
    observer.observe({ type: "resource" });
    return () => observer.disconnect();
  };
}

export interface HeapHost {
  readonly performance?: object;
}

/** Chromium's JavaScript heap in use, for `createMemorySource`; null in browsers that do not say. */
export function readHeapBytes(host: HeapHost = globalThis): () => number | null {
  return () => {
    // Chromium's non-standard performance.memory; other browsers have none.
    const memory = (host.performance as { memory?: { usedJSHeapSize?: unknown } } | undefined)?.memory;
    const used = memory?.usedJSHeapSize;
    return typeof used === "number" ? used : null;
  };
}
