import { describe, expect, it, vi } from "vitest";
import type { Scene } from "@babylonjs/core";
import { createTextureTransferTracker } from "../src/babylon/textureTransfers.js";

function harness(gpu: boolean) {
  const completions: (() => void)[] = [];
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, TIMEOUT_EXPIRED: 2, WAIT_FAILED: 3, ALREADY_SIGNALED: 4, CONDITION_SATISFIED: 5,
    fenceSync: vi.fn<() => WebGLSync | null>(() => ({}) as WebGLSync), flush: vi.fn(), finish: vi.fn(),
    clientWaitSync: vi.fn(() => 2), deleteSync: vi.fn(),
  };
  const queue = { onSubmittedWorkDone: vi.fn(() => new Promise<void>(resolve => completions.push(resolve))) };
  const engine = { isWebGPU: gpu, webGLVersion: 2, _gl: gl, _device: { queue } };
  const release = vi.fn();
  const admit = vi.fn(() => ({ release }));
  const requestRender = vi.fn();
  const tracker = createTextureTransferTracker({ scene: { getEngine: () => engine } as unknown as Scene, admit, requestRender });
  return { tracker, completions, release, admit, requestRender, gl, queue };
}

describe("host texture transfer completion", () => {
  it("keeps a throwing partial GPU submission charged through disposal and releases once", async () => {
    const h = harness(true);
    expect(() => h.tracker.transfer(16, "map", () => { throw new Error("partial submission"); })).toThrow("partial submission");
    h.tracker.dispose();
    expect(h.release).not.toHaveBeenCalled();
    h.completions[0](); await Promise.resolve();
    expect(h.release).toHaveBeenCalledOnce();
    h.tracker.deviceLost();
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("holds unknown GPU completion until the host observes loss", () => {
    const h = harness(true);
    h.queue.onSubmittedWorkDone.mockImplementation(() => { throw new Error("queue unavailable"); });
    h.tracker.transfer(16, "table", () => {}); h.tracker.dispose();
    expect(h.release).not.toHaveBeenCalled();
    h.tracker.deviceLost(); h.tracker.deviceLost();
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("requires a synchronous finish after a failed GL fence wait", () => {
    const h = harness(false);
    h.tracker.transfer(16, "tile", () => {}); h.tracker.pump();
    expect(h.release).not.toHaveBeenCalled();
    h.gl.clientWaitSync.mockReturnValue(h.gl.WAIT_FAILED); h.tracker.pump();
    expect(h.gl.finish).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
    h.tracker.dispose(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("retains a GL copy when fence creation and synchronous finish both fail", () => {
    const h = harness(false);
    h.gl.fenceSync.mockReturnValue(null);
    h.gl.finish.mockImplementation(() => { throw new Error("finish failed"); });
    expect(() => h.tracker.transfer(16, "tile", () => {})).toThrow("finish failed");
    expect(h.release).not.toHaveBeenCalled();
    h.tracker.deviceLost(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("consumes an already admitted grant without acquiring another one", async () => {
    const h = harness(true); const release = vi.fn();
    expect(h.tracker.track({ release }, () => 7)).toBe(7);
    expect(h.admit).not.toHaveBeenCalled();
    h.completions[0](); await Promise.resolve(); expect(release).toHaveBeenCalledOnce();
  });
  it("finishes work submitted after reentrant disposal before releasing its admitted GL2 hold", () => {
    const h = harness(false); const events: string[] = [];
    h.gl.finish.mockImplementation(() => { events.push("finish"); expect(events).toEqual(["dispose", "last native copy", "finish"]); expect(h.release).not.toHaveBeenCalled(); });
    const result = h.tracker.track({ release: h.release }, () => {
      h.tracker.dispose(); events.push("dispose"); expect(h.release).not.toHaveBeenCalled();
      // The synchronous submit callback may still issue native work afterward.
      events.push("last native copy"); return 7;
    });
    expect(result).toBe(7); expect(h.gl.finish).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
    expect(h.gl.fenceSync).not.toHaveBeenCalled(); expect(h.requestRender).not.toHaveBeenCalled();
    h.tracker.pump(); h.tracker.dispose(); h.tracker.deviceLost(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("retains an unfinished reentrant teardown submission after finish fails until actual context loss", () => {
    const h = harness(false);
    h.gl.finish.mockImplementation(() => { throw new Error("Completion still unknown"); });
    expect(() => h.tracker.track({ release: h.release }, () => { h.tracker.dispose(); })).toThrow("Completion still unknown");
    expect(h.release).not.toHaveBeenCalled(); h.tracker.pump(); h.tracker.dispose();
    expect(h.release).not.toHaveBeenCalled(); expect(h.gl.finish).toHaveBeenCalledOnce();
    h.tracker.deviceLost(); h.tracker.deviceLost(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("finishes prior fences during disposal without releasing the currently unfinished submit", () => {
    const h = harness(false); const priorRelease = vi.fn(), currentRelease = vi.fn();
    h.tracker.track({ release: priorRelease }, () => {});
    let currentFinished = false;
    h.gl.finish.mockImplementation(() => { if (currentFinished) expect(priorRelease).toHaveBeenCalledOnce(); expect(currentRelease).not.toHaveBeenCalled(); });
    h.tracker.track({ release: currentRelease }, () => {
      h.tracker.dispose(); expect(priorRelease).toHaveBeenCalledOnce(); expect(currentRelease).not.toHaveBeenCalled();
      currentFinished = true;
    });
    expect(h.gl.finish).toHaveBeenCalledTimes(2);
    expect(currentRelease).toHaveBeenCalledOnce(); expect(priorRelease).toHaveBeenCalledOnce();
    h.tracker.deviceLost(); expect(currentRelease).toHaveBeenCalledOnce(); expect(priorRelease).toHaveBeenCalledOnce();
  });
  it("cleans a fence created by a native port that reenters tracker disposal", () => {
    const h = harness(false);
    h.gl.fenceSync.mockImplementationOnce(() => { h.tracker.dispose(); return {} as WebGLSync; });
    h.tracker.track({ release: h.release }, () => {});
    expect(h.gl.finish).toHaveBeenCalledOnce(); expect(h.gl.deleteSync).toHaveBeenCalledOnce();
    expect(h.gl.flush).not.toHaveBeenCalled(); expect(h.requestRender).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce(); h.tracker.deviceLost(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("refuses capacity before calling a native submit port", () => {
    const submit = vi.fn();
    const tracker = createTextureTransferTracker({ scene: { getEngine: () => ({}) } as unknown as Scene, admit: () => null, requestRender() {} });
    expect(() => tracker.transfer(16, "table", submit)).toThrow("capacity");
    expect(submit).not.toHaveBeenCalled();
    tracker.dispose();
  });
});


describe("completion-aware transfer admissions", () => {
  it("admits and retains before copy, then reports upload only after proven GPU completion", async () => {
    const h = harness(true), input = vi.fn(), copy = vi.fn();
    const admission = h.tracker.tryAdmit(16, "owned", () => input)!;
    expect(h.admit).toHaveBeenCalledWith(16, "owned"); expect(admission.active).toBe(true);
    let settled = false; void admission.settled.then(() => { settled = true; });
    admission.submit(copy); await Promise.resolve();
    expect(copy).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    expect(input).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
    h.completions[0](); expect(await admission.settled).toEqual({ status: "uploaded" });
    expect(await admission.retired).toEqual({ status: "completed" });
    expect(input).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
    admission.submit(copy); admission.cancel(); h.tracker.dispose(); expect(copy).toHaveBeenCalledOnce();
  });
  it("does not retain input when upload capacity refuses the complete batch", () => {
    const h = harness(true), retain = vi.fn(() => () => {});
    h.admit.mockReturnValueOnce(null as unknown as ReturnType<typeof h.admit>);
    expect(h.tracker.tryAdmit(16, "owned", retain)).toBeNull(); expect(retain).not.toHaveBeenCalled(); h.tracker.dispose();
  });
  it("cancels unsubmitted ownership and independently reports all release failures", async () => {
    const h = harness(true), reason = new Error("Replaced"), inputError = new Error("input release"), grantError = new Error("grant release");
    const input = vi.fn(() => { throw inputError; }); h.release.mockImplementation(() => { throw grantError; });
    const admission = h.tracker.tryAdmit(16, "owned", () => input)!;
    admission.cancel(reason);
    expect(await admission.settled).toEqual({ status: "failed", error: reason });
    const retirement = await admission.retired; expect(retirement.status).toBe("completed");
    expect((retirement.cleanupError as AggregateError).errors).toEqual([inputError, grantError]);
    expect(input).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
    const copy = vi.fn(); admission.submit(copy); expect(copy).not.toHaveBeenCalled(); h.tracker.dispose();
  });
  it("retains native input after cancellation and ordinary dispose until actual completion", async () => {
    const h = harness(true), input = vi.fn(), reason = new Error("Cancelled");
    const admission = h.tracker.tryAdmit(16, "owned", () => input)!; admission.submit(() => {});
    admission.cancel(reason); h.tracker.dispose(); expect(await admission.settled).toEqual({ status: "failed", error: reason });
    expect(input).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
    h.completions[0](); expect((await admission.retired).status).toBe("completed");
    expect(input).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("never reports upload or retirement for a rejected native completion before observed loss", async () => {
    const h = harness(true), input = vi.fn(), reason = new Error("queue rejected");
    let reject!: (error: unknown) => void;
    h.queue.onSubmittedWorkDone.mockImplementationOnce(() => new Promise<void>((_resolve, failure) => { reject = failure; }));
    const admission = h.tracker.tryAdmit(16, "owned", () => input)!; admission.submit(() => {});
    let retired = false; void admission.retired.then(() => { retired = true; });
    reject(reason); expect(await admission.settled).toEqual({ status: "failed", error: reason }); h.tracker.dispose();
    await Promise.resolve(); expect(retired).toBe(false); expect(input).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
    h.tracker.deviceLost(); expect(await admission.retired).toEqual({ status: "device-lost" });
    expect(input).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("retains unknown completion after a hook throw and preserves the failed result through loss", async () => {
    const h = harness(true), input = vi.fn(), reason = new Error("No completion observer");
    h.queue.onSubmittedWorkDone.mockImplementationOnce(() => { throw reason; });
    const admission = h.tracker.tryAdmit(16, "owned", () => input)!; admission.submit(() => {});
    expect(await admission.settled).toEqual({ status: "failed", error: reason });
    expect(input).not.toHaveBeenCalled(); h.tracker.deviceLost();
    expect((await admission.retired).status).toBe("device-lost"); expect(input).toHaveBeenCalledOnce();
  });
  it("retains a partial throwing copy through proven retirement without publishing it", async () => {
    const h = harness(true), input = vi.fn(), reason = new Error("partial native copy");
    const admission = h.tracker.tryAdmit(16, "owned", () => input)!; admission.submit(() => { throw reason; });
    expect(await admission.settled).toEqual({ status: "failed", error: reason }); expect(input).not.toHaveBeenCalled();
    h.completions[0](); expect((await admission.retired).status).toBe("completed"); expect(input).toHaveBeenCalledOnce();
    h.tracker.dispose();
  });
  it("holds a returned producer release until a retention callback that observes loss returns", async () => {
    const h = harness(true), input = vi.fn();
    const admission = h.tracker.tryAdmit(16, "owned", () => {
      h.tracker.deviceLost(); expect(input).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled(); return input;
    })!;
    expect(admission.active).toBe(false); expect(await admission.settled).toEqual({ status: "device-lost" });
    expect(await admission.retired).toEqual({ status: "device-lost" }); expect(input).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("holds active synchronous copy input through reentrant loss and prevents its later copies", async () => {
    const h = harness(true), input = vi.fn();
    const admission = h.tracker.tryAdmit(16, "owned", () => input)!;
    admission.submit(isActive => {
      h.tracker.deviceLost(); expect(isActive()).toBe(false); expect(input).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
    });
    expect(await admission.settled).toEqual({ status: "device-lost" }); expect(await admission.retired).toEqual({ status: "device-lost" });
    expect(input).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledOnce();
  });
  it("settles ready GL peers independently after one fence deletion and input release fail", async () => {
    const h = harness(false), firstInput = vi.fn(() => { throw new Error("input stop"); }), secondInput = vi.fn();
    const first = h.tracker.tryAdmit(16, "first", () => firstInput)!, second = h.tracker.tryAdmit(16, "second", () => secondInput)!;
    first.submit(() => {}); second.submit(() => {}); h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED);
    h.gl.deleteSync.mockImplementationOnce(() => { throw new Error("delete fence"); });
    expect(() => h.tracker.pump()).toThrow("pump failed");
    expect(await first.settled).toEqual({ status: "uploaded" }); expect(await second.settled).toEqual({ status: "uploaded" });
    expect((await first.retired).cleanupError).toBeInstanceOf(AggregateError); expect(await second.retired).toEqual({ status: "completed" });
    expect(firstInput).toHaveBeenCalledOnce(); expect(secondInput).toHaveBeenCalledOnce(); expect(h.release).toHaveBeenCalledTimes(2); h.tracker.dispose();
  });
});
