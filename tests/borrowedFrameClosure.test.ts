import { describe, expect, it, vi } from "vitest";
import { createBorrowedFrameClosure } from "../src/borrowedFrameClosure.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const order: string[] = [], controller = new AbortController(), native = deferred();
  let raf!: (time: number) => void;
  const prepare = vi.fn((time: number) => { order.push(`prepare:${time}`); });
  const after = vi.fn((_time: number, painted: boolean) => { order.push(`after:${painted}`); });
  const stop = vi.fn(() => { order.push("stop"); }), error = vi.fn(() => { order.push("error"); });
  const closure = createBorrowedFrameClosure({ signal: controller.signal,
    presentation: () => ({ renderFrame(before, rendered) { order.push("begin"); try { before(); order.push("paint"); rendered(); } finally { order.push("end"); } } }),
    prepareFrame: prepare, afterFrame: after, shouldKeepRendering: () => false, minFrameIntervalMs: () => 0,
    stopScheduler: stop, onFrameError: error, cleanup: [() => { order.push("cancel-native"); }], whenOwnersSettled: [() => native.promise],
  });
  const scheduler = closure.schedulerOptions({ requestFrame(callback) { raf = callback; return 1; }, cancelFrame() {} });
  return { closure, controller, order, prepare, after, stop, error, native, frame(time: number) { scheduler.requestFrame(() => scheduler.tick()); raf(time); } };
}
describe("borrowed frame closure", () => {
  it("uses the supplied frame once and runs retirement after end/after bookkeeping", async () => {
    const f = fixture(); f.prepare.mockImplementation(() => { f.controller.abort(); }); f.frame(21);
    expect(f.order).toEqual(["begin", "end", "after:false", "cancel-native"]);
    let done = false; const retired = f.closure.whenSettled().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false); f.native.resolve(); await retired; expect(done).toBe(true);
    f.frame(22); expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it("preserves the host timestamp and stops before reporting a fatal prepare failure", () => {
    const f = fixture(); f.frame(123); expect(f.prepare).toHaveBeenCalledWith(123);
    expect(f.order).toEqual(["begin", "prepare:123", "paint", "end", "after:true"]);
    f.prepare.mockImplementation(() => { throw new Error("prepare failed"); }); f.frame(124);
    expect(f.order.slice(-4)).toEqual(["end", "after:false", "stop", "error"]);
    f.closure.dispose(); f.native.resolve();
  });
  it("attempts all cleanup and waits every real drain despite a cleanup error", async () => {
    const native = deferred(), later = vi.fn();
    const closure = createBorrowedFrameClosure({ presentation: () => undefined, prepareFrame() {}, afterFrame() {},
      shouldKeepRendering: () => false, minFrameIntervalMs: () => 0, stopScheduler() {}, onFrameError() {},
      cleanup: [() => { throw new Error("first cleanup"); }, later], whenOwnersSettled: [() => native.promise] });
    expect(() => closure.dispose()).toThrow("cleanup"); expect(later).toHaveBeenCalledOnce();
    let done = false; const rejection = expect(closure.whenSettled().finally(() => { done = true; })).rejects.toThrow("retirement");
    await Promise.resolve(); expect(done).toBe(false); native.resolve(); await rejection;
  });
});
