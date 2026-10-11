import type { Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createTextureTransferTracker } from "../src/babylon/textureTransfers.js";
import { whenBorrowedDeviceSettled } from "../src/babylon/nativeDeviceSettlement.js";
const deferred = () => { let resolve!: () => void, reject!: (e: unknown) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
it("holds submitted input and grant after cancellation until the actual GPU completion", async () => {
  const gpu = deferred(), input = vi.fn(), release = vi.fn();
  const tracker = createTextureTransferTracker({ scene: { getEngine: () => ({ isWebGPU: true, _device: { queue: { onSubmittedWorkDone: () => gpu.promise } } }) } as unknown as Scene,
    admit: () => ({ release }), requestRender() {} });
  const ticket = tracker.tryAdmit(16, "fixture", () => input)!; ticket.submit(() => {}); ticket.cancel(); tracker.dispose();
  let done = false; const retirement = tracker.whenSettled().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); expect(input).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
  gpu.resolve(); await retirement; expect(input).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
});
it("attempts both releases and reports their failures after true completion", async () => {
  const gpu = deferred(), input = vi.fn(() => { throw new Error("input cleanup"); }), release = vi.fn(() => { throw new Error("grant cleanup"); });
  const tracker = createTextureTransferTracker({ scene: { getEngine: () => ({ isWebGPU: true, _device: { queue: { onSubmittedWorkDone: () => gpu.promise } } }) } as unknown as Scene,
    admit: () => ({ release }), requestRender() {} });
  tracker.tryAdmit(4, "fixture", () => input)!.submit(() => {}); tracker.dispose();
  const failed = expect(tracker.whenSettled()).rejects.toThrow("retirement"); gpu.resolve(); await failed;
  expect(input).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
});
describe("final borrowed native device marker", () => {
  for (const webGLVersion of [1, 2]) it(`finishes actual WebGL${webGLVersion} work without a replacement device`, async () => {
    const finish = vi.fn(), stop = vi.fn();
    await whenBorrowedDeviceSettled({ scene: { getEngine: () => ({ webGLVersion, _gl: { finish } }) } as unknown as Scene,
      observeDeviceLoss: () => stop, onError() {} });
    expect(finish).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce();
  });
  it("includes a subscription release failure after synchronously observed loss", async () => {
    const stop = vi.fn(() => { throw new Error("loss listener cleanup"); });
    await expect(whenBorrowedDeviceSettled({ scene: { getEngine: () => ({}) } as unknown as Scene,
      observeDeviceLoss(listener) { listener(); return stop; }, onError() {},
    })).rejects.toThrow("loss listener cleanup");
    expect(stop).toHaveBeenCalledOnce();
  });
  it("keeps a rejected completion pending until actual loss and then exposes the error", async () => {
    const gpu = deferred(), lost = deferred(), onError = vi.fn(), stop = vi.fn();
    const pending = whenBorrowedDeviceSettled({ scene: { getEngine: () => ({ isWebGPU: true, _device: { queue: { onSubmittedWorkDone: () => gpu.promise }, lost: lost.promise } }) } as unknown as Scene,
      observeDeviceLoss: () => stop, onError });
    let done = false; const failure = expect(pending.finally(() => { done = true; })).rejects.toThrow("queue");
    gpu.reject(new Error("queue rejected")); await Promise.resolve(); expect(done).toBe(false); expect(onError).toHaveBeenCalledOnce();
    lost.resolve(); await failure; expect(stop).toHaveBeenCalledOnce();
  });
});
