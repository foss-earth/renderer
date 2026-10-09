import { describe, expect, it, vi } from "vitest";
import { Constants, type InternalTexture, type Scene } from "@babylonjs/core";
import { createTextureDevicePorts, type RawTextureBatchRequest } from "../src/babylon/textureDevice.js";
import { createTextureTransferTracker } from "../src/babylon/textureTransfers.js";

function harness() {
  const events: string[] = [];
  let complete!: () => void;
  let reject!: (error: unknown) => void;
  const engine = {
    isWebGPU: true, getCaps: () => ({ maxTextureSize: 64 }),
    _device: { queue: { onSubmittedWorkDone: () => new Promise<void>((resolve, failure) => { complete = resolve; reject = failure; }) } },
    updateTextureData: vi.fn(),
  };
  const scene = { getEngine: () => engine } as unknown as Scene;
  const texture = { getEngine: () => engine, isCube: false, width: 8, height: 8, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_BYTE } as unknown as InternalTexture;
  const releaseUpload = vi.fn(() => { events.push("release upload"); });
  const admit = vi.fn(() => { events.push("admit upload"); return { release: releaseUpload }; });
  const releaseInput = vi.fn(() => { events.push("release input"); });
  const retainInput = vi.fn(() => { events.push("retain input"); return releaseInput; });
  const releaseCopy = vi.fn(() => { events.push("release copy"); });
  const reserveCopy = vi.fn(() => { events.push("admit copy"); return { release: releaseCopy }; });
  const tracker = createTextureTransferTracker({ scene, admit, requestRender() {} });
  const device = createTextureDevicePorts({ scene, transfer: tracker.transfer, tryAdmit: tracker.tryAdmit });
  const data = new Uint8Array(16).fill(17);
  const request: RawTextureBatchRequest = { label: "feature batch", regions: [{ texture, data, x: 0, y: 0, width: 2, height: 2 }], retainInput, reserveCopy };
  return { events, engine, texture, scene, device, tracker, data, request, admit, reserveCopy, retainInput, releaseCopy, releaseInput, releaseUpload, complete: () => complete(), reject: (error: unknown) => reject(error) };
}

describe("immutable completion-aware raw RGBA8 batches", () => {
  it("reserves the complete upload and snapshot before copy and ignores later caller mutations", async () => {
    const h = harness(); const batch = h.device.prepareRawTextureBatch(h.request)!;
    expect(h.events).toEqual(["admit upload", "retain input", "admit copy"]); expect(batch.bytes).toBe(16); expect(batch.active).toBe(true);
    expect(h.engine.updateTextureData).not.toHaveBeenCalled(); h.data.fill(99);
    batch.submit(); const actual = h.engine.updateTextureData.mock.calls[0][1] as Uint8Array;
    expect([...actual]).toEqual(Array(16).fill(17)); expect(actual).not.toBe(h.data);
    expect(h.releaseCopy).not.toHaveBeenCalled(); expect(h.releaseInput).not.toHaveBeenCalled();
    h.complete(); expect(await batch.settled).toEqual({ status: "uploaded" }); expect(await batch.retired).toEqual({ status: "completed" });
    expect(h.events.slice(-3)).toEqual(["release copy", "release input", "release upload"]); h.tracker.dispose();
  });
  it("validates every region and total geometry before any capacity or native call", () => {
    const h = harness();
    expect(() => h.device.prepareRawTextureBatch({ ...h.request, regions: [...h.request.regions, { ...h.request.regions[0], lod: 3, width: 2 }] })).toThrow("storage");
    expect(h.admit).not.toHaveBeenCalled(); expect(h.retainInput).not.toHaveBeenCalled(); expect(h.reserveCopy).not.toHaveBeenCalled();
    expect(h.engine.updateTextureData).not.toHaveBeenCalled(); h.tracker.dispose();
  });
  it("refuses a complete upload without producer retention or a copy reservation", () => {
    const h = harness(); h.admit.mockReturnValueOnce(null as unknown as ReturnType<typeof h.admit>);
    expect(h.device.prepareRawTextureBatch(h.request)).toBeNull(); expect(h.retainInput).not.toHaveBeenCalled(); expect(h.reserveCopy).not.toHaveBeenCalled(); h.tracker.dispose();
  });
  it("returns a failed unsubmitted batch when copy capacity refuses and attempts producer/upload cleanup", async () => {
    const h = harness(), reason = new Error("copy capacity"); h.reserveCopy.mockImplementationOnce(() => { throw reason; });
    const batch = h.device.prepareRawTextureBatch(h.request)!; batch.submit();
    expect(await batch.settled).toEqual({ status: "failed", error: reason }); expect(await batch.retired).toEqual({ status: "completed" });
    expect(h.releaseInput).toHaveBeenCalledOnce(); expect(h.releaseUpload).toHaveBeenCalledOnce(); expect(h.engine.updateTextureData).not.toHaveBeenCalled(); h.tracker.dispose();
  });
  it("skips snapshots/native work after copy admission synchronously disposes its tracker", async () => {
    const h = harness(); h.reserveCopy.mockImplementationOnce(() => { h.tracker.dispose(); return { release: h.releaseCopy }; });
    const batch = h.device.prepareRawTextureBatch(h.request)!; h.data.fill(42); batch.submit();
    expect(batch.active).toBe(false); expect((await batch.settled).status).toBe("failed"); expect((await batch.retired).status).toBe("completed");
    expect(h.releaseCopy).toHaveBeenCalledOnce(); expect(h.releaseInput).toHaveBeenCalledOnce(); expect(h.releaseUpload).toHaveBeenCalledOnce(); expect(h.engine.updateTextureData).not.toHaveBeenCalled();
  });
  it("preserves owner region/mip/layer order under one complete admission and native completion", async () => {
    const h = harness(); h.texture.isCube = true;
    const batch = h.device.prepareRawTextureBatch({ ...h.request, regions: [
      { texture: h.texture, data: new Uint8Array(64), x: 1, y: 2, width: 4, height: 4, faceIndex: 5, lod: 0 },
      { texture: h.texture, data: new Uint8Array(16), x: 1, y: 1, width: 2, height: 2, faceIndex: 2, lod: 1 },
    ] })!;
    expect(batch.bytes).toBe(80); expect(h.admit).toHaveBeenCalledOnce(); batch.submit();
    expect(h.engine.updateTextureData.mock.calls.map(call => call.slice(2))).toEqual([[1, 2, 4, 4, 5, 0, false], [1, 1, 2, 2, 2, 1, false]]);
    h.complete(); expect((await batch.settled).status).toBe("uploaded"); await batch.retired; h.tracker.dispose();
  });
  it("stops later regions on reentrant cancellation and keeps all holds through partial native completion", async () => {
    const h = harness(); const batch = h.device.prepareRawTextureBatch({ ...h.request, regions: [h.request.regions[0], h.request.regions[0]] })!;
    const reason = new Error("generation retired"); h.engine.updateTextureData.mockImplementationOnce(() => batch.cancel(reason)); batch.submit();
    expect(h.engine.updateTextureData).toHaveBeenCalledOnce(); expect(await batch.settled).toEqual({ status: "failed", error: reason });
    expect(h.releaseCopy).not.toHaveBeenCalled(); expect(h.releaseInput).not.toHaveBeenCalled(); h.complete(); await batch.retired;
    expect(h.releaseCopy).toHaveBeenCalledOnce(); expect(h.releaseInput).toHaveBeenCalledOnce(); h.tracker.dispose();
  });
  it("quarantines rejected native completion through dispose until actual loss", async () => {
    const h = harness(); const batch = h.device.prepareRawTextureBatch(h.request)!, reason = new Error("native rejected"); batch.submit(); h.reject(reason);
    expect(await batch.settled).toEqual({ status: "failed", error: reason }); h.tracker.dispose();
    expect(h.releaseCopy).not.toHaveBeenCalled(); expect(h.releaseInput).not.toHaveBeenCalled(); expect(h.releaseUpload).not.toHaveBeenCalled();
    h.tracker.deviceLost(); expect(await batch.retired).toEqual({ status: "device-lost" });
    expect(h.releaseCopy).toHaveBeenCalledOnce(); expect(h.releaseInput).toHaveBeenCalledOnce(); expect(h.releaseUpload).toHaveBeenCalledOnce();
  });
  it("attempts copy, producer and upload releases independently after one cleanup throws", async () => {
    const h = harness(), reason = new Error("copy release"); h.releaseCopy.mockImplementationOnce(() => { throw reason; });
    const batch = h.device.prepareRawTextureBatch(h.request)!; batch.cancel();
    expect((await batch.retired).cleanupError).toBe(reason); expect(h.releaseInput).toHaveBeenCalledOnce(); expect(h.releaseUpload).toHaveBeenCalledOnce(); h.tracker.dispose();
  });
  it("keeps legacy raw ports structural and refuses missing completion capability explicitly", () => {
    const h = harness(); const legacy = createTextureDevicePorts({ scene: h.scene, transfer: h.tracker.transfer });
    expect(() => legacy.prepareRawTextureBatch(h.request)).toThrow("explicit admission"); expect(h.admit).not.toHaveBeenCalled(); h.tracker.dispose();
  });
});
