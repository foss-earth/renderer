import { createRenderScheduler, type RenderScheduler, type WorkRenderScheduler, type RenderSchedulerOptions, type RenderFrameCallback } from "@foss-earth/renderer/core";

/** Source-only declaration fixture; actual host supplies one clock/frame queue. */
export function borrowOneWorkScheduler(host: RenderSchedulerOptions): WorkRenderScheduler {
  return createRenderScheduler({
    tick: () => host.tick(),
    work: timeMs => host.work?.(timeMs),
    shouldKeepWorking: () => host.shouldKeepWorking?.() ?? false,
    shouldKeepRendering: () => host.shouldKeepRendering?.() ?? false,
    minFrameIntervalMs: () => host.minFrameIntervalMs?.() ?? 0,
    requestFrame: (callback: RenderFrameCallback) => host.requestFrame(callback),
    cancelFrame: handle => host.cancelFrame(handle),
  });
}
export const legacyStructuralMock: RenderScheduler = {
  requestRender() {}, beginContinuous() {}, endContinuous() {}, isContinuous: () => false,
  setPaused() {}, stop() {}, isActive: () => false, onActiveChange: () => () => {},
};
export function mapHiddenAndVisibleRequests(scheduler: WorkRenderScheduler) {
  return {
    // Older upload/transfer field names accept the host's work-only callback.
    hiddenNativePorts: { requestRender: () => scheduler.requestWork() },
    visiblePublication: { requestRender: () => scheduler.requestRender() },
  };
}
