import { afterEach, describe, expect, it, vi } from "vitest";
import { Constants, type Scene } from "@babylonjs/core";
import { createImageTextureUploader } from "../src/babylon/imageTextureUpload.js";
import type { ImageTextureUploader, UploadedImageTexture } from "../src/babylon/imageUploadTypes.js";

vi.mock("@babylonjs/core", async importOriginal => ({
  ...await importOriginal<typeof import("@babylonjs/core")>(),
  BaseTexture: class {
    private internal: { dispose(): void } | null;
    constructor(_scene: unknown, internal: { dispose(): void }) { this.internal = internal; }
    releaseInternalTexture() { this.internal?.dispose(); this.internal = null; }
    dispose() { this.releaseInternalTexture(); }
  },
}));

class StagingCanvas {
  readonly context = { globalCompositeOperation: "source-over", imageSmoothingEnabled: true, drawImage: vi.fn<(...args: unknown[]) => void>() };
  width: number;
  height: number;
  constructor(width: number, height: number) { this.width = width; this.height = height; }
  getContext() { return this.context; }
}

function harness(version: 1 | 2, bytesPerFrame = 32, outstandingBytes = 32) {

  const gl = {
    TEXTURE_CUBE_MAP: 34067, TEXTURE_2D: 3553, TEXTURE_CUBE_MAP_POSITIVE_X: 34069,
    UNPACK_FLIP_Y_WEBGL: 37440, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 37441, UNPACK_COLORSPACE_CONVERSION_WEBGL: 37443, NONE: 0,
    RGBA: 6408, UNSIGNED_BYTE: 5121, SYNC_GPU_COMMANDS_COMPLETE: 37143, TIMEOUT_EXPIRED: 37147, ALREADY_SIGNALED: 37146,
    getParameter: vi.fn(() => 0), pixelStorei: vi.fn(), texSubImage2D: vi.fn<(...args: unknown[]) => void>(), generateMipmap: vi.fn(),
    WAIT_FAILED: 37149, fenceSync: vi.fn<() => object | null>(() => ({})), clientWaitSync: vi.fn(() => 37147), deleteSync: vi.fn(), flush: vi.fn(), finish: vi.fn(),
  };
  const internal = () => ({ isReady: false, generateMipMaps: false, dispose: vi.fn() });
  const engine = {
    _gl: gl, webGLVersion: version,
    getCaps: () => ({ maxTextureSize: 64 }),
    createRawCubeTexture: vi.fn(internal), createRawTexture: vi.fn(internal),
    _bindTextureDirectly: vi.fn(), _unpackFlipY: vi.fn(), updateTextureSamplingMode: vi.fn(),
  };
  const requestRender = vi.fn();
  const createStagingCanvas = vi.fn((width: number, height: number) => new StagingCanvas(width, height) as unknown as OffscreenCanvas);
  const generic = createImageTextureUploader({ scene: { getEngine: () => engine } as unknown as Scene, limits: { bytesPerFrame, outstandingBytes }, requestRender, invalidatePublishedSource() { throw new Error("GL has no rejected asynchronous completion hook"); }, createStagingCanvas });
  const controller = new AbortController();
  let heldBytes = 0;
  const tickets: { bytes: number; released: boolean }[] = [];
  const reserveUpload = (bytes: number) => { const ticket = { bytes, released: false }; tickets.push(ticket); heldBytes += bytes; return { release() { if (ticket.released) return; ticket.released = true; heldBytes -= bytes; } }; };
  const uploader: Omit<ImageTextureUploader, "upload"> & { uploadEquirect(image: ImageBitmap, label: string): Promise<UploadedImageTexture>; uploadCube(faces: readonly ImageBitmap[], label: string): Promise<UploadedImageTexture> } = { ...generic,
    uploadEquirect: (image, label) => generic.upload({ kind: "2d", images: [image], label, signal: controller.signal, reserveUpload, reserveDecodedStaging: () => ({ release() {} }) }),
    uploadCube: (faces, label) => generic.upload({ kind: "cube", images: faces, label, signal: controller.signal, reserveUpload, reserveDecodedStaging: () => ({ release() {} }) }),
  };
  const bitmap = (width: number, height: number, id = "image") => ({ width, height, id }) as unknown as ImageBitmap;
  return { uploader, generic, reserveUpload, engine, gl, requestRender, createStagingCanvas, bitmap, controller, tickets, heldBytes: () => heldBytes };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("generic WebGL image uploads", () => {
  it("uploads bounded strips without reading pixels back and waits for WebGL 2 fences", async () => {
    const h = harness(2);
    const loading = h.uploader.uploadEquirect(h.bitmap(4, 4), "test");
    expect(h.uploader.pump()).toBe(32);
    expect(h.gl.texSubImage2D.mock.calls[0].slice(0, 4)).toEqual([h.gl.TEXTURE_2D, 0, 0, 0]);
    const canvas = h.gl.texSubImage2D.mock.calls[0][6] as unknown as StagingCanvas;
    // Staging is zeroed once this frame has submitted its rows.
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(canvas.context.drawImage.mock.calls[0].slice(1)).toEqual([0, 0, 4, 2, 0, 0, 4, 2]);
    expect(h.uploader.stats().outstandingBytes).toBe(32);
    expect(h.heldBytes()).toBe(32);
    expect(h.uploader.pump()).toBe(0);
    h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED);
    expect(h.uploader.pump()).toBe(32);
    const texture = await loading;
    expect(texture.complete).toBe(true);
    expect(texture.levels).toBe(3);
    expect(texture.gpuBytes).toBe(84);
    expect(h.gl.generateMipmap).toHaveBeenCalledExactlyOnceWith(h.gl.TEXTURE_2D);
    expect(h.gl.texSubImage2D.mock.calls[1][3]).toBe(2);
    expect(h.uploader.stats().uploadedBytes).toBe(64);
    h.uploader.pump();
    expect(h.uploader.stats().outstandingBytes).toBe(0);
    expect(h.heldBytes()).toBe(0);
    texture.dispose();
    expect(h.engine.createRawTexture.mock.results[0].value.dispose).toHaveBeenCalledOnce();
  });

  it("accepts caller-ordered cube layers and uploads fitting faces directly", async () => {
    const h = harness(1, 4096, 4096);
    const order = ["px", "nx", "pz", "nz", "py", "ny"];
    const faces = order.map(face => h.bitmap(4, 4, face));
    const loading = h.uploader.uploadCube(faces, "cube");
    expect(h.uploader.pump()).toBe(6 * 4 * 4 * 4);
    const texture = await loading;
    expect(h.gl.texSubImage2D.mock.calls.map(call => call[0])).toEqual(order.map((_, index) => h.gl.TEXTURE_CUBE_MAP_POSITIVE_X + index));
    expect(h.gl.texSubImage2D.mock.calls.map(call => (call[6] as unknown as { id: string }).id)).toEqual(order);
    expect(h.gl.generateMipmap).toHaveBeenCalledExactlyOnceWith(h.gl.TEXTURE_CUBE_MAP);
    expect(texture.gpuBytes).toBe(6 * 84);
    expect(h.gl.fenceSync).not.toHaveBeenCalled();
    texture.dispose();
  });

  it("supports WebGL 1 NPOT images without illegal mipmaps or extra resizing", async () => {
    const h = harness(1, 4096, 4096);
    const loading = h.uploader.uploadEquirect(h.bitmap(6, 3), "npot");
    h.uploader.pump();
    const texture = await loading;
    expect(texture).toMatchObject({ width: 6, height: 3, levels: 1, gpuBytes: 72, complete: true });
    expect(h.gl.generateMipmap).not.toHaveBeenCalled();
    expect(h.engine.updateTextureSamplingMode).not.toHaveBeenCalled();
    texture.dispose();
  });

  it("cancellation preserves submitted tickets until the WebGL2 fence completes", async () => {
    const h = harness(2);
    const loading = h.uploader.uploadEquirect(h.bitmap(4, 4), "abort");
    h.uploader.pump();
    h.controller.abort(new Error("Cancelled"));
    await expect(loading).rejects.toThrow("Cancelled");
    expect(h.heldBytes()).toBe(32);
    h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED);
    h.uploader.pump();
    expect(h.heldBytes()).toBe(0);
  });

  it("caps WebGL 1 submissions by the outstanding allowance and releases cancelled uploads", async () => {
    const h = harness(1, 64, 16);
    const loading = h.uploader.uploadEquirect(h.bitmap(4, 4), "cancel");
    expect(h.uploader.pump()).toBe(16);
    expect(h.uploader.stats()).toMatchObject({ queuedJobs: 1, outstandingBytes: 0, uploadedBytes: 16 });
    h.uploader.cancelAll("Scene removed");
    await expect(loading).rejects.toThrow("Scene removed");
    expect(h.engine.createRawTexture.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    expect(h.uploader.busy()).toBe(false);
  });
  it("tracks a partial throwing copy until the GL2 fence completes", async () => {
    const h = harness(2);
    h.gl.texSubImage2D.mockImplementation(() => { throw new Error("Partial copy"); });
    const loading = h.uploader.uploadEquirect(h.bitmap(4, 4), "partial");
    h.uploader.pump(); await expect(loading).rejects.toThrow("Partial copy");
    expect(h.heldBytes()).toBe(32);
    h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED); h.uploader.pump();
    expect(h.heldBytes()).toBe(0);
  });
  it("finishes a failed GL wait before releasing staging", async () => {
    const h = harness(2);
    const loading = h.uploader.uploadEquirect(h.bitmap(4, 4), "wait-failed");
    h.uploader.pump(); h.controller.abort(new Error("Replaced"));
    await expect(loading).rejects.toThrow("Replaced");
    h.gl.clientWaitSync.mockReturnValue(h.gl.WAIT_FAILED); h.uploader.pump();
    expect(h.gl.finish).toHaveBeenCalledOnce(); expect(h.heldBytes()).toBe(0);
  });
  it("retains unknown completion after fence and finish failure until actual loss", async () => {
    const h = harness(2);
    h.gl.fenceSync.mockReturnValue(null); h.gl.finish.mockImplementation(() => { throw new Error("Finish unknown"); });
    const loading = h.uploader.uploadEquirect(h.bitmap(4, 4), "unknown");
    expect(() => h.uploader.pump()).toThrow("Finish unknown");
    expect(h.heldBytes()).toBe(32);
    h.uploader.cancelAll("Device lost", { deviceLost: true });
    await expect(loading).rejects.toThrow("Device lost");
    expect(h.heldBytes()).toBe(0);
  });
  it("keeps six cube faces incomplete until the final layer and mip fence are submitted", async () => {
    const h = harness(2, 32, 32);
    const loading = h.uploader.uploadCube(Array.from({ length: 6 }, (_, index) => h.bitmap(2, 2, String(index))), "cube");
    let published = false; void loading.then(() => { published = true; });
    h.uploader.pump(); await Promise.resolve(); expect(published).toBe(false);
    expect(h.gl.generateMipmap).not.toHaveBeenCalled();
    h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED);
    h.uploader.pump(); await Promise.resolve(); expect(published).toBe(false);
    h.uploader.pump(); const texture = await loading;
    expect(h.gl.texSubImage2D.mock.calls.map(call => call[0])).toEqual(Array.from({ length: 6 }, (_, index) => h.gl.TEXTURE_CUBE_MAP_POSITIVE_X + index));
    expect(h.gl.generateMipmap).toHaveBeenCalledExactlyOnceWith(h.gl.TEXTURE_CUBE_MAP);
    expect(texture.complete).toBe(true); expect(h.heldBytes()).toBe(32);
    h.uploader.pump(); expect(h.heldBytes()).toBe(0); texture.dispose();
  });
  it("keeps the next job when a native copy synchronously aborts the current one", async () => {
    const h = harness(2, 32, 32), next = new AbortController();
    const first = h.uploader.uploadEquirect(h.bitmap(1, 1), "first");
    const second = h.generic.upload({ kind: "2d", images: [h.bitmap(1, 1)], label: "next", signal: next.signal, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release() {} }) });
    h.gl.texSubImage2D.mockImplementationOnce(() => h.controller.abort(new Error("Replaced during copy")));
    h.uploader.pump(); await expect(first).rejects.toThrow("Replaced during copy");
    const texture = await second; expect(texture.complete).toBe(true); expect(h.heldBytes()).toBe(8);
    h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED); h.uploader.pump();
    expect(h.heldBytes()).toBe(0); texture.dispose();
  });
  it("does not retain a newly fenced current copy after synchronous observed context loss", async () => {
    const h = harness(2); const loading = h.uploader.uploadEquirect(h.bitmap(1, 1), "lost");
    h.gl.texSubImage2D.mockImplementation(() => h.uploader.cancelAll("Lost during copy", { deviceLost: true }));
    h.uploader.pump(); await expect(loading).rejects.toThrow("Lost during copy");
    expect(h.heldBytes()).toBe(0); expect(h.gl.fenceSync).not.toHaveBeenCalled();
    expect(() => h.uploader.uploadEquirect(h.bitmap(1, 1), "retired")).toThrow("lost");
  });
  for (const phase of ["fence", "flush"] as const) for (const deviceLost of [false, true]) {
    it(`cancels unpublished ready ownership during ${phase}${deviceLost ? " with observed loss" : " while native work stays live"}`, async () => {
      const h = harness(2); const reason = `Cancelled at ${phase}`;
      const loading = h.uploader.uploadEquirect(h.bitmap(1, 1), "handoff");
      const rejected = expect(loading).rejects.toThrow(reason);
      const cancel = () => h.uploader.cancelAll(reason, { deviceLost });
      if (phase === "fence") h.gl.fenceSync.mockImplementationOnce(() => { cancel(); return {}; });
      else h.gl.flush.mockImplementationOnce(cancel);
      h.uploader.pump(); await rejected;
      expect(h.engine.createRawTexture.mock.results[0].value.dispose).toHaveBeenCalledOnce();
      expect(h.uploader.busy()).toBe(false); expect(h.uploader.stats().queuedJobs).toBe(0);
      expect(h.heldBytes()).toBe(deviceLost ? 0 : 4);
      if (!deviceLost) {
        h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED); h.uploader.pump();
        expect(h.heldBytes()).toBe(0);
      } else expect(() => h.uploader.uploadEquirect(h.bitmap(1, 1), "retired")).toThrow("lost");
      expect(h.tickets.every(ticket => ticket.released)).toBe(true);
      h.uploader.cancelAll("Again", { deviceLost: true });
      expect(h.engine.createRawTexture.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    });
  }
  it("settles every unpublished ready peer when flush cancels the whole host upload batch", async () => {
    const h = harness(2), next = new AbortController();
    const first = h.uploader.uploadEquirect(h.bitmap(1, 1), "first");
    const second = h.generic.upload({ kind: "2d", images: [h.bitmap(1, 1)], label: "second", signal: next.signal, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release() {} }) });
    const rejected = Promise.all([expect(first).rejects.toThrow("Batch replaced"), expect(second).rejects.toThrow("Batch replaced")]);
    h.gl.flush.mockImplementationOnce(() => h.uploader.cancelAll("Batch replaced"));
    h.uploader.pump(); await rejected;
    expect(h.uploader.busy()).toBe(false); expect(h.heldBytes()).toBe(8);
    for (const result of h.engine.createRawTexture.mock.results) expect(result.value.dispose).toHaveBeenCalledOnce();
    h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED); h.uploader.pump(); expect(h.heldBytes()).toBe(0);
  });
  it("does not release an already drained flight again when finish observes context loss", async () => {
    const h = harness(2); const loading = h.uploader.uploadEquirect(h.bitmap(1, 1), "finish");
    const rejected = expect(loading).rejects.toThrow("Lost at finish");
    h.gl.fenceSync.mockReturnValue(null);
    h.gl.finish.mockImplementationOnce(() => h.uploader.cancelAll("Lost at finish", { deviceLost: true }));
    h.uploader.pump(); await rejected;
    expect(h.heldBytes()).toBe(0); expect(h.uploader.stats().outstandingBytes).toBe(0);
    expect(h.engine.createRawTexture.mock.results[0].value.dispose).toHaveBeenCalledOnce();
  });
  it("keeps bounded legacy map RGBA/mips/flip/trilinear semantics for legal GL1 POT input", async () => {
    const h = harness(1, 4096, 4096);
    const loading = h.generic.upload({ kind: "2d", images: [h.bitmap(4, 4)], label: "map", signal: h.controller.signal, textureColor: { useSRGBBuffer: false, gammaSpace: true }, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release() {} }) });
    h.uploader.pump(); const texture = await loading;
    expect(texture.texture.gammaSpace).toBe(true); expect(texture.levels).toBe(3);
    expect(h.engine.createRawTexture.mock.calls[0].slice(0, 7)).toEqual([null, 4, 4, Constants.TEXTUREFORMAT_RGBA, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE]);
    expect(h.engine._unpackFlipY).toHaveBeenCalledWith(false);
    expect(h.gl.generateMipmap).toHaveBeenCalledExactlyOnceWith(h.gl.TEXTURE_2D);
    expect(h.engine.updateTextureSamplingMode).toHaveBeenCalledWith(Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, expect.anything()); texture.dispose();
  });
  it("refuses unsupported explicit GL sRGB storage before native allocation", () => {
    const h = harness(2);
    expect(() => h.generic.upload({ kind: "2d", images: [h.bitmap(1, 1)], label: "wrong storage", signal: h.controller.signal, textureColor: { useSRGBBuffer: true, gammaSpace: false }, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release() {} }) })).toThrow("unavailable");
    expect(h.engine.createRawTexture).not.toHaveBeenCalled();
  });
  it("releases an upload grant without staging or copying after its admission callback cancels", async () => {
    const h = harness(2);
    const loading = h.generic.upload({ kind: "2d", images: [h.bitmap(4, 4)], label: "admission", signal: h.controller.signal,
      reserveUpload(bytes) { const ticket = h.reserveUpload(bytes); h.uploader.cancelAll("Cancelled by upload admission"); return ticket; },
      reserveDecodedStaging() { throw new Error("No staging after cancellation"); } });
    const rejected = expect(loading).rejects.toThrow("Cancelled by upload admission"); h.uploader.pump(); await rejected;
    expect(h.createStagingCanvas).not.toHaveBeenCalled(); expect(h.gl.texSubImage2D).not.toHaveBeenCalled();
    expect(h.gl.fenceSync).not.toHaveBeenCalled(); expect(h.heldBytes()).toBe(0);
    expect(h.tickets.every(ticket => ticket.released)).toBe(true);
  });
  it("does not create/draw a strip after decoded-staging admission aborts its pending job", async () => {
    const h = harness(2); const releaseDecoded = vi.fn();
    const loading = h.generic.upload({ kind: "2d", images: [h.bitmap(4, 4)], label: "decoded admission", signal: h.controller.signal, reserveUpload: h.reserveUpload,
      reserveDecodedStaging() { h.controller.abort(new Error("Cancelled by decoded admission")); return { release: releaseDecoded }; } });
    const rejected = expect(loading).rejects.toThrow("Cancelled by decoded admission"); h.uploader.pump(); await rejected;
    expect(h.createStagingCanvas).not.toHaveBeenCalled(); expect(h.gl.texSubImage2D).not.toHaveBeenCalled();
    expect(releaseDecoded).toHaveBeenCalledOnce(); expect(h.heldBytes()).toBe(0); expect(h.gl.fenceSync).not.toHaveBeenCalled();
  });
  it("empties a newly returned host canvas and releases grants if its factory cancels the job", async () => {
    const h = harness(2), canvas = new StagingCanvas(4, 2); const releaseDecoded = vi.fn();
    h.createStagingCanvas.mockImplementationOnce(() => { h.uploader.cancelAll("Cancelled by canvas factory"); return canvas as unknown as OffscreenCanvas; });
    const loading = h.generic.upload({ kind: "2d", images: [h.bitmap(4, 4)], label: "canvas admission", signal: h.controller.signal, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release: releaseDecoded }) });
    const rejected = expect(loading).rejects.toThrow("Cancelled by canvas factory"); h.uploader.pump(); await rejected;
    expect(canvas.context.drawImage).not.toHaveBeenCalled(); expect([canvas.width, canvas.height]).toEqual([0, 0]);
    expect(h.gl.texSubImage2D).not.toHaveBeenCalled(); expect(releaseDecoded).toHaveBeenCalledOnce(); expect(h.heldBytes()).toBe(0);
    expect(h.gl.fenceSync).not.toHaveBeenCalled();
  });
  it("restores upload state without copying after native binding cancels pending ownership", async () => {
    const h = harness(2); const loading = h.uploader.uploadEquirect(h.bitmap(1, 1), "binding");
    const rejected = expect(loading).rejects.toThrow("Cancelled by bind");
    h.engine._bindTextureDirectly.mockImplementationOnce(() => { h.uploader.cancelAll("Cancelled by bind"); });
    h.uploader.pump(); await rejected;
    expect(h.gl.texSubImage2D).not.toHaveBeenCalled(); expect(h.gl.fenceSync).not.toHaveBeenCalled(); expect(h.heldBytes()).toBe(0);
    expect(h.engine._bindTextureDirectly).toHaveBeenLastCalledWith(h.gl.TEXTURE_2D, null, true);
  });
});


describe("WebGL independent cleanup and staging ownership", () => {
  it("attempts both canvas dimensions and settles every ready peer after a reset throws", async () => {
    const h = harness(2, 48, 48), peer = new AbortController(), decodedRelease = vi.fn();
    const first = h.generic.upload({ kind: "2d", images: [h.bitmap(4, 4)], label: "strip", signal: h.controller.signal, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release: decodedRelease }) });
    h.uploader.pump(); h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED);
    let width = 4, height = 1; const heightWrites: number[] = [];
    const canvas = {
      get width() { return width; }, set width(value: number) { if (value === 0) throw new Error("Width reset failed"); width = value; },
      get height() { return height; }, set height(value: number) { heightWrites.push(value); height = value; },
      getContext: () => new StagingCanvas(4, 1).context,
    };
    h.createStagingCanvas.mockImplementationOnce(() => canvas as unknown as OffscreenCanvas);
    const second = h.generic.upload({ kind: "2d", images: [h.bitmap(1, 1)], label: "peer", signal: peer.signal, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release() {} }) });
    const rejected = Promise.all([expect(first).rejects.toThrow("Width reset failed"), expect(second).rejects.toThrow("Width reset failed")]);
    expect(() => h.uploader.pump()).toThrow("Width reset failed"); await rejected;
    expect(heightWrites).toContain(0); expect(decodedRelease).toHaveBeenCalledTimes(2); expect(h.uploader.busy()).toBe(false);
    for (const result of h.engine.createRawTexture.mock.results) expect(result.value.dispose).toHaveBeenCalledOnce();
    h.uploader.pump(); expect(h.heldBytes()).toBe(0);
  });
  it("retains an unproven canvas allocation even through observed loss and retires it only after a later observed zero", async () => {
    const h = harness(2), releaseDecoded = vi.fn();
    let blocked = false, width = 4, height = 2;
    const canvas = {
      get width() { if (blocked) throw new Error("Width unreadable"); return width; },
      set width(value: number) { if (value === 0 && blocked) throw new Error("Width reset refused"); width = value; },
      get height() { if (blocked) throw new Error("Height unreadable"); return height; },
      set height(value: number) { if (value === 0 && blocked) throw new Error("Height reset refused"); height = value; },
      getContext: () => new StagingCanvas(4, 2).context,
    };
    h.createStagingCanvas.mockImplementationOnce(() => canvas as unknown as OffscreenCanvas);
    h.gl.texSubImage2D.mockImplementationOnce(() => { blocked = true; });
    const loading = h.generic.upload({ kind: "2d", images: [h.bitmap(4, 4)], label: "quarantined", signal: h.controller.signal, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release: releaseDecoded }) });
    expect(() => h.uploader.pump()).toThrow("pump failed"); expect(releaseDecoded).not.toHaveBeenCalled();
    const rejected = expect(loading).rejects.toThrow("Observed loss");
    expect(() => h.uploader.cancelAll("Observed loss", { deviceLost: true })).toThrow("cleanup failed"); await rejected;
    expect(releaseDecoded).not.toHaveBeenCalled(); blocked = false;
    h.uploader.pump(); expect([width, height]).toEqual([0, 0]); expect(releaseDecoded).toHaveBeenCalledOnce();
  });
  it("defers staging reset and decoded release until a native copy that cancels returns", async () => {
    const h = harness(2), releaseDecoded = vi.fn();
    const loading = h.generic.upload({ kind: "2d", images: [h.bitmap(4, 4)], label: "reentrant copy", signal: h.controller.signal, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release: releaseDecoded }) });
    const rejected = expect(loading).rejects.toThrow("Replaced inside native copy");
    h.gl.texSubImage2D.mockImplementationOnce((...args) => {
      const canvas = args[6] as StagingCanvas; h.uploader.cancelAll("Replaced inside native copy");
      expect([canvas.width, canvas.height]).toEqual([4, 2]); expect(releaseDecoded).not.toHaveBeenCalled();
      expect(h.uploader.pump()).toBe(0);
    });
    h.uploader.pump(); await rejected; expect(releaseDecoded).toHaveBeenCalledOnce(); expect(h.heldBytes()).toBe(32);
    h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED); h.uploader.pump(); expect(h.heldBytes()).toBe(0);
  });
  it("attempts every flight ticket after one release throws", async () => {
    const h = harness(2), peer = new AbortController(), firstRelease = vi.fn(() => { throw new Error("First grant release"); }), secondRelease = vi.fn();
    const first = h.generic.upload({ kind: "2d", images: [h.bitmap(1, 1)], label: "first", signal: h.controller.signal, reserveUpload: () => ({ release: firstRelease }), reserveDecodedStaging: () => ({ release() {} }) });
    const second = h.generic.upload({ kind: "2d", images: [h.bitmap(1, 1)], label: "second", signal: peer.signal, reserveUpload: () => ({ release: secondRelease }), reserveDecodedStaging: () => ({ release() {} }) });
    h.uploader.pump(); const textures = await Promise.all([first, second]);
    h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED); expect(() => h.uploader.pump()).toThrow("First grant release");
    expect(firstRelease).toHaveBeenCalledOnce(); expect(secondRelease).toHaveBeenCalledOnce(); expect(h.uploader.stats().outstandingBytes).toBe(0);
    textures.forEach(texture => texture.dispose());
  });
  it("settles the next ready job when the first abort listener cannot detach", async () => {
    const h = harness(2), peer = new AbortController();
    vi.spyOn(h.controller.signal, "removeEventListener").mockImplementationOnce(() => { throw new Error("Abort detach failed"); });
    const first = h.uploader.uploadEquirect(h.bitmap(1, 1), "first");
    const second = h.generic.upload({ kind: "2d", images: [h.bitmap(1, 1)], label: "second", signal: peer.signal, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release() {} }) });
    const rejected = expect(first).rejects.toThrow("Abort detach failed"); expect(() => h.uploader.pump()).toThrow("Abort detach failed");
    await rejected; const texture = await second; expect(texture.complete).toBe(true); expect(h.uploader.busy()).toBe(false);
    expect(h.engine.createRawTexture.mock.results[0].value.dispose).toHaveBeenCalledOnce();
    h.gl.clientWaitSync.mockReturnValue(h.gl.ALREADY_SIGNALED); h.uploader.pump(); texture.dispose();
  });
  it("settles all cancelled peers when one texture disposal throws", async () => {
    const h = harness(2), peer = new AbortController();
    const first = h.uploader.uploadEquirect(h.bitmap(1, 1), "first");
    const second = h.generic.upload({ kind: "2d", images: [h.bitmap(1, 1)], label: "second", signal: peer.signal, reserveUpload: h.reserveUpload, reserveDecodedStaging: () => ({ release() {} }) });
    h.engine.createRawTexture.mock.results[0].value.dispose.mockImplementation(() => { throw new Error("Texture stop failed"); });
    const rejected = Promise.all([expect(first).rejects.toThrow("All replaced"), expect(second).rejects.toThrow("All replaced")]);
    h.uploader.cancelAll("All replaced"); await rejected; expect(h.uploader.busy()).toBe(false);
    expect(h.engine.createRawTexture.mock.results[1].value.dispose).toHaveBeenCalledOnce();
  });
});
