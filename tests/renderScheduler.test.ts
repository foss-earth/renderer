import { describe, expect, it, vi } from "vitest";

import { createRenderScheduler, type RenderFrameCallback } from "../src/renderScheduler.js";

interface FakeRaf {
  request: (cb: RenderFrameCallback) => number;
  cancel: (handle: number) => void;
  run: () => void;
  pending: () => number;
}

function createFakeRaf(): FakeRaf {
  let nextId = 1;
  const queue = new Map<number, RenderFrameCallback>();
  return {
    request(cb) {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    cancel(id) {
      queue.delete(id);
    },
    run() {
      const entries = Array.from(queue.entries());
      queue.clear();
      for (const [, cb] of entries) cb(performance.now());
    },
    pending() {
      return queue.size;
    },
  };
}

describe("createRenderScheduler", () => {
  it("does not render until requested", () => {
    const raf = createFakeRaf();
    const tick = vi.fn();
    createRenderScheduler({
      tick,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    expect(raf.pending()).toBe(0);
    expect(tick).not.toHaveBeenCalled();
  });

  it("renders one frame per requestRender() and then idles", () => {
    const raf = createFakeRaf();
    const tick = vi.fn();
    const scheduler = createRenderScheduler({
      tick,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.requestRender();
    expect(raf.pending()).toBe(1);
    raf.run();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(raf.pending()).toBe(0);
    raf.run();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("coalesces multiple requestRender() calls into a single frame", () => {
    const raf = createFakeRaf();
    const tick = vi.fn();
    const scheduler = createRenderScheduler({
      tick,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.requestRender();
    scheduler.requestRender();
    scheduler.requestRender();
    expect(raf.pending()).toBe(1);
    raf.run();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("keeps rendering while continuous mode is held", () => {
    const raf = createFakeRaf();
    const tick = vi.fn();
    const scheduler = createRenderScheduler({
      tick,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.beginContinuous();
    expect(raf.pending()).toBe(1);
    raf.run();
    expect(raf.pending()).toBe(1);
    raf.run();
    expect(tick).toHaveBeenCalledTimes(2);
    scheduler.endContinuous();
    raf.run();
    expect(raf.pending()).toBe(0);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it("refcounts continuous mode", () => {
    const raf = createFakeRaf();
    const scheduler = createRenderScheduler({
      tick: () => undefined,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.beginContinuous();
    scheduler.beginContinuous();
    expect(scheduler.isContinuous()).toBe(true);
    scheduler.endContinuous();
    expect(scheduler.isContinuous()).toBe(true);
    scheduler.endContinuous();
    expect(scheduler.isContinuous()).toBe(false);
  });

  it("keeps rendering while shouldKeepRendering() is true", () => {
    const raf = createFakeRaf();
    let active = true;
    const tick = vi.fn();
    const scheduler = createRenderScheduler({
      tick,
      shouldKeepRendering: () => active,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.requestRender();
    raf.run();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(raf.pending()).toBe(1); // still active
    raf.run();
    expect(tick).toHaveBeenCalledTimes(2);
    active = false;
    raf.run(); // shouldKeepRendering became false during this frame
    expect(tick).toHaveBeenCalledTimes(3);
    expect(raf.pending()).toBe(0);
  });

  it("pauses and resumes", () => {
    const raf = createFakeRaf();
    const tick = vi.fn();
    const scheduler = createRenderScheduler({
      tick,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.beginContinuous();
    expect(raf.pending()).toBe(1);
    scheduler.setPaused(true);
    expect(scheduler.isActive()).toBe(false);
    expect(raf.pending()).toBe(0);
    scheduler.requestRender();
    expect(raf.pending()).toBe(0);
    scheduler.setPaused(false);
    expect(raf.pending()).toBe(1);
    raf.run();
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels pending frame and prevents future ones", () => {
    const raf = createFakeRaf();
    const tick = vi.fn();
    const scheduler = createRenderScheduler({
      tick,
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.requestRender();
    scheduler.stop();
    expect(raf.pending()).toBe(0);
    scheduler.requestRender();
    expect(raf.pending()).toBe(0);
    expect(tick).not.toHaveBeenCalled();
  });

  it("finishes stop despite a throwing cancel port and notifies all activity observers", () => {
    const raf = createFakeRaf(); const cancelError = new Error("cancel failed"), observerError = new Error("observer failed");
    const tick = vi.fn(); const scheduler = createRenderScheduler({ tick, requestFrame: raf.request, cancelFrame: () => { throw cancelError; } });
    const changes: boolean[] = [];
    scheduler.onActiveChange(active => { if (!active) throw observerError; });
    scheduler.onActiveChange(active => changes.push(active));
    scheduler.beginContinuous();
    let failure: unknown; try { scheduler.stop(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual([cancelError, observerError]);
    expect(changes).toEqual([true, false]); expect(scheduler.isActive()).toBe(false); expect(scheduler.isContinuous()).toBe(false);
    const late = vi.fn(); scheduler.onActiveChange(late); scheduler.beginContinuous(); scheduler.requestRender();
    raf.run(); expect(tick).not.toHaveBeenCalled(); expect(late).not.toHaveBeenCalled(); expect(scheduler.isContinuous()).toBe(false);
    expect(() => scheduler.stop()).not.toThrow();
  });

  it("does not replay stale activity notifications after a listener stops the scheduler", () => {
    const raf = createFakeRaf(), tick = vi.fn();
    const scheduler = createRenderScheduler({ tick, requestFrame: raf.request, cancelFrame: raf.cancel });
    const first: boolean[] = [], second: boolean[] = [];
    scheduler.onActiveChange(active => { first.push(active); if (active) scheduler.stop(); });
    scheduler.onActiveChange(active => second.push(active));
    scheduler.requestRender();
    expect(first).toEqual([true, false]); expect(second).toEqual([false]); expect(raf.pending()).toBe(0);
    scheduler.requestRender(); raf.run(); expect(tick).not.toHaveBeenCalled(); expect(second).toEqual([false]);
  });

  it("caps the frame rate at renderer.frameRateCap, waiting out frames that come too soon", () => {
    const queue: RenderFrameCallback[] = [];
    const tick = vi.fn();
    let interval = 1000 / 30;
    const scheduler = createRenderScheduler({
      tick,
      minFrameIntervalMs: () => interval,
      requestFrame: cb => { queue.push(cb); return queue.length; },
      cancelFrame: () => undefined,
    });
    // A 60 Hz display: a frame each 16.7 ms.
    const display = (at: number) => { const cb = queue.shift(); cb?.(at); };
    scheduler.beginContinuous();
    for (let frame = 0; frame < 6; frame++) display(frame * (1000 / 60));
    expect(tick).toHaveBeenCalledTimes(3);
    // Off again: every frame.
    interval = 0;
    for (let frame = 6; frame < 10; frame++) display(frame * (1000 / 60));
    expect(tick).toHaveBeenCalledTimes(7);
    scheduler.stop();
  });

  it("keeps a visible change requested during a tick for the following frame", () => {
    const raf = createFakeRaf();
    let ticks = 0;
    const scheduler = createRenderScheduler({
      tick: () => { ticks += 1; if (ticks === 1) scheduler.requestRender(); },
      requestFrame: raf.request,
      cancelFrame: raf.cancel,
    });
    scheduler.requestRender();
    raf.run();
    expect(ticks).toBe(1);
    expect(raf.pending()).toBe(1);
    raf.run();
    expect(ticks).toBe(2);
    expect(raf.pending()).toBe(0);
  });

  it("notifies once at each activity transition and removes subscribers", () => {
    const raf = createFakeRaf();
    const changed = vi.fn();
    const scheduler = createRenderScheduler({ tick: () => undefined, requestFrame: raf.request, cancelFrame: raf.cancel });
    const unsubscribe = scheduler.onActiveChange(changed);
    scheduler.requestRender();
    scheduler.requestRender();
    expect(changed.mock.calls).toEqual([[true]]);
    raf.run();
    expect(changed.mock.calls).toEqual([[true], [false]]);
    unsubscribe();
    scheduler.requestRender();
    scheduler.stop();
    expect(changed.mock.calls).toEqual([[true], [false]]);
  });
});


function manualFrames() {
  let next = 1;
  const callbacks = new Map<number, RenderFrameCallback>();
  const request = vi.fn((callback: RenderFrameCallback) => { const handle = next++; callbacks.set(handle, callback); return handle; });
  const cancel = vi.fn((handle: number) => { callbacks.delete(handle); });
  return {
    request, cancel, pending: () => callbacks.size,
    first: () => [...callbacks.values()][0],
    run(time: number) { const ready = [...callbacks.values()]; callbacks.clear(); for (const callback of ready) callback(time); },
  };
}

describe("work and presentation on one supplied frame queue", () => {
  it("pumps requested hidden work with the host timestamp without painting or idle polling", () => {
    const raf = manualFrames(), tick = vi.fn(), work = vi.fn(), changed = vi.fn();
    const scheduler = createRenderScheduler({ tick, work, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.onActiveChange(changed); scheduler.requestWork(); scheduler.requestWork();
    expect(raf.pending()).toBe(1); raf.run(42);
    expect(work).toHaveBeenCalledExactlyOnceWith(42); expect(tick).not.toHaveBeenCalled();
    expect(raf.pending()).toBe(0); expect(changed.mock.calls).toEqual([[true], [false]]); scheduler.stop();
  });
  it("coalesces hidden and visible requests into one work phase and one scene presentation", () => {
    const raf = manualFrames(), tick = vi.fn(), work = vi.fn();
    const scheduler = createRenderScheduler({ tick, work, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.requestWork(); scheduler.requestRender(); scheduler.requestWork(); scheduler.requestRender();
    expect(raf.request).toHaveBeenCalledOnce(); raf.run(10);
    expect(work).toHaveBeenCalledOnce(); expect(tick).toHaveBeenCalledOnce(); expect(raf.pending()).toBe(0); scheduler.stop();
  });
  it("presents a visible publication requested by work once in that same frame", () => {
    const raf = manualFrames(), tick = vi.fn(), order: string[] = [];
    const scheduler = createRenderScheduler({
      work() { order.push("work"); scheduler.requestRender(); scheduler.requestRender(); },
      tick() { order.push("paint"); tick(); }, requestFrame: raf.request, cancelFrame: raf.cancel,
    });
    scheduler.requestWork(); raf.run(20);
    expect(order).toEqual(["work", "paint"]); expect(tick).toHaveBeenCalledOnce(); expect(raf.pending()).toBe(0); scheduler.stop();
  });
  it("retains work requested during work for one following work-only frame", () => {
    const raf = manualFrames(), tick = vi.fn(); let worked = 0;
    const scheduler = createRenderScheduler({ work() { worked++; if (worked === 1) scheduler.requestWork(); }, tick, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.requestWork(); raf.run(1); expect(worked).toBe(1); expect(raf.pending()).toBe(1);
    raf.run(2); expect(worked).toBe(2); expect(tick).not.toHaveBeenCalled(); expect(raf.pending()).toBe(0); scheduler.stop();
  });
  it("preserves visible changes requested during paint for the next frame", () => {
    const raf = manualFrames(), work = vi.fn(); let draws = 0;
    const scheduler = createRenderScheduler({ work, tick() { draws++; if (draws === 1) scheduler.requestRender(); }, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.requestRender(); raf.run(1); expect(draws).toBe(1); expect(raf.pending()).toBe(1);
    raf.run(2); expect(draws).toBe(2); expect(work).toHaveBeenCalledTimes(2); expect(raf.pending()).toBe(0); scheduler.stop();
  });
  it("keeps admitted work progressing on frames withheld by the presentation cap", () => {
    const raf = manualFrames(), work = vi.fn(), tick = vi.fn();
    const scheduler = createRenderScheduler({ work, tick, minFrameIntervalMs: () => 40, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.beginContinuous(); raf.run(0); raf.run(10); raf.run(20);
    expect(work).toHaveBeenCalledTimes(3); expect(tick).toHaveBeenCalledOnce(); expect(raf.pending()).toBe(1);
    raf.run(40); expect(work).toHaveBeenCalledTimes(4); expect(tick).toHaveBeenCalledTimes(2);
    scheduler.endContinuous(); raf.run(80); expect(tick).toHaveBeenCalledTimes(3); expect(raf.pending()).toBe(0); scheduler.stop();
  });
  it("does not consult the presentation cap for work-only preparation", () => {
    const raf = manualFrames(), interval = vi.fn(() => 1000), tick = vi.fn(), work = vi.fn();
    const scheduler = createRenderScheduler({ work, tick, minFrameIntervalMs: interval, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.requestWork(); raf.run(3); expect(work).toHaveBeenCalledOnce(); expect(interval).not.toHaveBeenCalled(); expect(tick).not.toHaveBeenCalled(); scheduler.stop();
  });
  it("keeps a work-induced visible change pending until the next eligible presentation", () => {
    const raf = manualFrames(), tick = vi.fn(); let changed = false;
    const scheduler = createRenderScheduler({
      work() { if (changed) { changed = false; scheduler.requestRender(); } }, tick,
      minFrameIntervalMs: () => 30, requestFrame: raf.request, cancelFrame: raf.cancel,
    });
    scheduler.requestRender(); raf.run(0); changed = true; scheduler.requestWork(); raf.run(10);
    expect(tick).toHaveBeenCalledOnce(); expect(raf.pending()).toBe(1);
    raf.run(30); expect(tick).toHaveBeenCalledTimes(2); expect(raf.pending()).toBe(0); scheduler.stop();
  });
  it("continues only admitted work and lets a capacity-refused source wake it explicitly", () => {
    const raf = manualFrames(), tick = vi.fn(), work = vi.fn(); let admitted = true;
    const scheduler = createRenderScheduler({ work, tick, shouldKeepWorking: () => admitted, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.requestWork(); raf.run(1); expect(raf.pending()).toBe(1);
    admitted = false; raf.run(2); expect(work).toHaveBeenCalledTimes(2); expect(raf.pending()).toBe(0);
    // Existing capacity/native completion callback, not polling refused work.
    scheduler.requestWork(); raf.run(3); expect(work).toHaveBeenCalledTimes(3); expect(raf.pending()).toBe(0); expect(tick).not.toHaveBeenCalled(); scheduler.stop();
  });
  it("clears paused work wakes, ignores stale callbacks and preserves the first unpaused presentation", () => {
    const raf = manualFrames(), tick = vi.fn(), work = vi.fn();
    const scheduler = createRenderScheduler({ work, tick, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.requestWork(); const stale = raf.first(); scheduler.setPaused(true); scheduler.requestWork();
    expect(raf.pending()).toBe(0); scheduler.setPaused(false); stale(1); expect(raf.pending()).toBe(1);
    raf.run(2); expect(work).toHaveBeenCalledOnce(); expect(tick).toHaveBeenCalledOnce(); expect(raf.pending()).toBe(0); scheduler.stop();
  });
  it("skips old presentation after work reenters pause/unpause and schedules the newer first frame", () => {
    const raf = manualFrames(), tick = vi.fn(); let worked = 0;
    const scheduler = createRenderScheduler({ work() { worked++; if (worked === 1) { scheduler.setPaused(true); scheduler.setPaused(false); } }, tick, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.requestWork(); raf.run(1); expect(tick).not.toHaveBeenCalled(); expect(raf.pending()).toBe(1);
    raf.run(2); expect(worked).toBe(2); expect(tick).toHaveBeenCalledOnce(); expect(raf.pending()).toBe(0); scheduler.stop();
  });
  it("retires continuous/work authority and skips all later callbacks when work stops it", () => {
    const raf = manualFrames(), tick = vi.fn(), keep = vi.fn(() => true); let worked = 0;
    const scheduler = createRenderScheduler({ work() { worked++; scheduler.stop(); scheduler.requestWork(); scheduler.requestRender(); }, tick, shouldKeepWorking: keep, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.beginContinuous(); raf.run(1); expect(worked).toBe(1); expect(tick).not.toHaveBeenCalled(); expect(keep).not.toHaveBeenCalled();
    expect(scheduler.isContinuous()).toBe(false); expect(scheduler.isActive()).toBe(false); expect(raf.pending()).toBe(0);
    scheduler.requestWork(); raf.run(2); expect(worked).toBe(1);
  });
  it("attempts pause cancellation and every idle notification independently after failures", () => {
    const raf = manualFrames(), tick = vi.fn(), work = vi.fn(), cancelError = new Error("pause cancel"), idleError = new Error("pause observer");
    const changes: boolean[] = [];
    const scheduler = createRenderScheduler({ work, tick, requestFrame: raf.request, cancelFrame() { throw cancelError; } });
    scheduler.onActiveChange(active => { if (!active) throw idleError; }); scheduler.onActiveChange(active => changes.push(active)); scheduler.requestWork();
    let failure: unknown; try { scheduler.setPaused(true); } catch (error) { failure = error; }
    expect((failure as AggregateError).errors).toEqual([cancelError, idleError]); expect(changes).toEqual([true, false]); expect(scheduler.isActive()).toBe(false);
    raf.run(1); expect(work).not.toHaveBeenCalled(); expect(tick).not.toHaveBeenCalled(); scheduler.stop();
  });
  it("cancels a frame registration returned after the supplied port synchronously stops the scheduler", () => {
    const raf = manualFrames(), tick = vi.fn(), work = vi.fn();
    const scheduler = createRenderScheduler({ work, tick, requestFrame(callback) { const handle = raf.request(callback); scheduler.stop(); return handle; }, cancelFrame: raf.cancel });
    scheduler.requestWork(); expect(raf.cancel).toHaveBeenCalledOnce(); expect(raf.pending()).toBe(0); expect(scheduler.isActive()).toBe(false);
    raf.run(1); expect(work).not.toHaveBeenCalled(); expect(tick).not.toHaveBeenCalled();
  });
  it("does not paint/retry failed work and reports the work/idle failures while notifying remaining observers", () => {
    const raf = manualFrames(), tick = vi.fn(), reason = new Error("hidden work failed"), idle = new Error("idle report failed");
    const work = vi.fn<() => void>().mockImplementationOnce(() => { throw reason; }); const changes: boolean[] = [];
    const scheduler = createRenderScheduler({ work, tick, requestFrame: raf.request, cancelFrame: raf.cancel });
    scheduler.onActiveChange(active => { if (!active) throw idle; }); const unsubscribe = scheduler.onActiveChange(active => changes.push(active));
    scheduler.requestWork(); let failure: unknown; try { raf.run(1); } catch (error) { failure = error; }
    expect((failure as AggregateError).errors).toEqual([reason, idle]); expect(changes).toEqual([true, false]); expect(tick).not.toHaveBeenCalled(); expect(raf.pending()).toBe(0);
    unsubscribe(); scheduler.stop();
  });
  it("allows an explicit wake after a throwing frame registration without stranding activity", () => {
    const raf = manualFrames(), tick = vi.fn(), work = vi.fn(), reason = new Error("registration failed"); let failed = false;
    const scheduler = createRenderScheduler({ work, tick, requestFrame(callback) { if (!failed) { failed = true; throw reason; } return raf.request(callback); }, cancelFrame: raf.cancel });
    expect(() => scheduler.requestWork()).toThrow(reason); expect(scheduler.isActive()).toBe(false); expect(raf.pending()).toBe(0);
    scheduler.requestRender(); raf.run(1); expect(work).toHaveBeenCalledOnce(); expect(tick).toHaveBeenCalledOnce(); expect(raf.pending()).toBe(0); scheduler.stop();
  });
});
