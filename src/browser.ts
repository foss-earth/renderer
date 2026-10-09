import { createRenderScheduler, type WorkRenderScheduler, type RenderSchedulerOptions, type RenderFrameCallback } from "./renderScheduler.js";

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
