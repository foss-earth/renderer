import type { Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createNativeImageResources, type NativeImageResourceOptions } from "../src/babylon/nativeImageResources.js";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const complete = deferred(), aborted = new AbortController(), timers: (() => void)[] = [], stop = vi.fn();
  const engine = { isWebGPU: true, _device: { queue: {} }, updateTextureData: vi.fn(), getCaps: () => ({ maxTextureSize: 2048 }) };
  const uploader = { upload: vi.fn(), pump: vi.fn(() => 0), busy: () => true, stats: () => ({ queuedJobs: 0, outstandingBytes: 4, lastFrameBytes: 0, uploadedBytes: 0, publishedCompletionFailures: 0, lastPublishedCompletionFailure: null }), setLimits() {}, cancelAll: vi.fn(), whenSettled: () => complete.promise };
  const options: NativeImageResourceOptions = { broker: { pools: { reserve: () => ({ ok: true, reservation: { release() {} } }) }, invalidate() {} },
    scene: { getEngine: () => engine } as unknown as Scene,
    limits: () => ({ bytesPerFrame: 64, outstandingBytes: 64 }), wakeWork() {}, createCanvas: () => ({} as HTMLCanvasElement), invalidatePublishedSource() {},
    after(callback) { timers.push(callback); return stop; }, observeDeviceLoss: () => stop, onRetirementError: vi.fn(), signal: aborted.signal,
    createUploader: () => uploader };
  return { complete, aborted, uploader, timers, stop, options };
}
describe("borrowed native resources", () => {
  it("starts retirement on abort while the device lives, and does not turn cancellation into completion", async () => {
    const f = fixture(), native = createNativeImageResources(f.options); f.aborted.abort();
    expect(f.uploader.cancelAll).toHaveBeenCalledOnce(); expect(native.retiring).toBe(true);
    let done = false; const retirement = native.whenSettled().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false); native.resourceWork.prepare(); expect(f.uploader.pump).not.toHaveBeenCalled();
    f.complete.resolve(); await retirement; expect(f.stop).toHaveBeenCalled(); expect(() => native.restoreDevice()).toThrow("retired");
  });
  it("contains errors but still waits actual retirement and attempts the final release callback", async () => {
    const f = fixture(), released = vi.fn(); f.uploader.cancelAll.mockImplementation(() => { throw new Error("cancel failed"); });
    const native = createNativeImageResources(f.options); native.dispose(released);
    const failed = expect(native.whenSettled()).rejects.toThrow("retirement"); expect(released).not.toHaveBeenCalled();
    f.complete.resolve(); await failed; await Promise.resolve(); expect(released).toHaveBeenCalledOnce();
  });
  it("rejects actual uploader startup failure without constructing another renderer or broker", () => {
    const f = fixture(); f.options.createUploader = () => { throw new Error("native startup"); };
    expect(() => createNativeImageResources(f.options)).toThrow("native startup"); expect(f.uploader.pump).not.toHaveBeenCalled();
  });
  it("retains an old adapter's real cleanup proof across an observed loss and restoration", async () => {
    const f = fixture(), replacement = deferred();
    let count = 0;
    f.options.createUploader = () => ++count === 1 ? f.uploader : { ...f.uploader, whenSettled: () => replacement.promise };
    const native = createNativeImageResources(f.options);
    native.observedDeviceLoss(); native.restoreDevice(); native.retire();
    let done = false; const drain = native.whenSettled().then(() => { done = true; });
    replacement.resolve(); await Promise.resolve(); await Promise.resolve(); expect(done).toBe(false);
    f.complete.resolve(); await drain; expect(count).toBe(2);
  });
  it("attempts a compatible final callback once and preserves its cleanup failure", async () => {
    const f = fixture(), released = vi.fn(() => { throw new Error("final release"); });
    const native = createNativeImageResources(f.options); native.dispose(released); native.dispose(released);
    f.complete.resolve(); await expect(native.whenSettled()).rejects.toThrow("retirement");
    expect(released).toHaveBeenCalledOnce();
  });
});
