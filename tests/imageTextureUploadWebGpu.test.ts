import { beforeEach, describe, expect, it, vi } from "vitest";
import { Constants, type Scene } from "@babylonjs/core";
import { createImageTextureUploader } from "../src/babylon/imageTextureUpload.js";
import type { ImageUploadRequest } from "../src/babylon/imageUploadTypes.js";

const disposal = vi.hoisted(() => ({ fail: false, internals: [] as { dispose: ReturnType<typeof vi.fn>; _useSRGBBuffer?: boolean; format?: number; type?: number; invertY?: boolean; samplingMode?: number }[] }));
beforeEach(() => { disposal.fail = false; disposal.internals.length = 0; });
vi.mock("@babylonjs/core", async importOriginal => ({
  ...await importOriginal<typeof import("@babylonjs/core")>(),
  InternalTexture: class {
    _hardwareTexture = { underlyingResource: {} };
    dispose = vi.fn();
    constructor() { disposal.internals.push(this); }
  },
  BaseTexture: class {
    constructor(_scene: unknown, private internal: { dispose(): void } | null) {}
    releaseInternalTexture() { this.internal?.dispose(); this.internal = null; }
    dispose() { if (disposal.fail) throw new Error("Observer failed"); this.releaseInternalTexture(); }
  },
}));
function harness() {
  const completions: { resolve(): void; reject(error: unknown): void }[] = [];
  const device = { queue: {
    copyExternalImageToTexture: vi.fn(),
    onSubmittedWorkDone: () => new Promise<void>((resolve, reject) => completions.push({ resolve, reject })),
  } };
  const engine = { isWebGPU: true, getCaps: () => ({ maxTextureSize: 64 }), _device: device, _textureHelper: { createGPUTextureForInternalTexture: vi.fn(), generateCubeMipmaps: vi.fn(), generateMipmaps: vi.fn() } };
  const requestRender = vi.fn();
  const invalidatePublishedSource = vi.fn();
  const uploader = createImageTextureUploader({ scene: { getEngine: () => engine } as unknown as Scene, limits: { bytesPerFrame: 32, outstandingBytes: 32 }, requestRender, invalidatePublishedSource, createStagingCanvas: () => { throw new Error("GPU upload never needs a canvas"); } });
  const controller = new AbortController();
  let reserved = 0;
  const release = vi.fn();
  const reserveUpload = (bytes: number) => { reserved += bytes; let done = false; return { release() { if (done) return; done = true; reserved -= bytes; release(bytes); } }; };
  const bitmap = (width: number, height: number) => ({ width, height }) as ImageBitmap;
  const upload = (images: ImageBitmap[], kind: "2d" | "cube" = "2d", signal = controller.signal, textureColor?: ImageUploadRequest["textureColor"]) => uploader.upload({ kind, images, label: "fixture", signal, textureColor, reserveUpload, reserveDecodedStaging: () => { throw new Error("No GPU canvas"); } });
  return { uploader, engine, completions, requestRender, invalidatePublishedSource, controller, release, bitmap, upload, reserveUpload, reserved: () => reserved };
}
describe("generic supplied-device GPU uploads", () => {
  it("retains each shared staging ticket until submitted rows and mips finish", async () => {
    const h = harness();
    const loading = h.upload([h.bitmap(4, 4)]);
    expect(h.uploader.pump()).toBe(32);
    expect(h.uploader.pump()).toBe(0);
    expect(h.reserved()).toBe(32);
    h.completions[0].resolve(); await Promise.resolve();
    expect(h.reserved()).toBe(0);
    expect(h.uploader.pump()).toBe(32);
    const texture = await loading;
    expect(texture).toMatchObject({ kind: "2d", complete: true, levels: 3, gpuBytes: 84 });
    expect(h.engine._textureHelper.generateMipmaps).toHaveBeenCalledOnce();
    expect(h.reserved()).toBe(32);
    h.completions[1].resolve(); await Promise.resolve();
    expect(h.reserved()).toBe(0);
    expect(h.release).toHaveBeenCalledTimes(2);
    texture.dispose();
  });
  it("abort releases queued texture while completion still owns submitted staging", async () => {
    const h = harness();
    const loading = h.upload([h.bitmap(4, 4)]);
    h.uploader.pump(); h.controller.abort(new Error("Replaced"));
    await expect(loading).rejects.toThrow("Replaced");
    expect(h.uploader.stats().queuedJobs).toBe(0);
    expect(h.reserved()).toBe(32);
    h.completions[0].resolve(); await Promise.resolve();
    expect(h.reserved()).toBe(0);
  });
  it("device loss rejects queued work and releases completion tickets exactly once", async () => {
    const h = harness();
    const loading = h.upload([h.bitmap(4, 4)]);
    h.uploader.pump(); h.uploader.cancelAll("Device lost", { deviceLost: true });
    await expect(loading).rejects.toThrow("Device lost");
    expect(h.reserved()).toBe(0);
    h.completions[0].reject(new Error("Lost")); await Promise.resolve();
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("rejects an unfinished job on native completion failure without transferring ownership", async () => {
    const h = harness(); const loading = h.upload([h.bitmap(4, 4)]);
    const rejected = expect(loading).rejects.toThrow("Native completion failed");
    h.uploader.pump(); h.completions[0].reject(new Error("Native completion failed"));
    await rejected;
    expect(disposal.internals[0].dispose).toHaveBeenCalledOnce();
    expect(h.invalidatePublishedSource).not.toHaveBeenCalled();
    expect(h.reserved()).toBe(0); expect(h.uploader.stats().publishedCompletionFailures).toBe(0);
  });
  it("reports a published cube's late completion failure once without disposing caller ownership", async () => {
    const h = harness();
    const loading = h.upload(Array.from({ length: 6 }, () => h.bitmap(1, 1)), "cube");
    h.uploader.pump(); const texture = await loading;
    expect(texture.complete).toBe(true); expect(h.reserved()).toBe(24);
    const error = new Error("Late native completion failed");
    h.completions[0].reject(error); h.completions[1].reject(new Error("Same job's later failure"));
    await Promise.resolve();
    expect(h.invalidatePublishedSource).toHaveBeenCalledExactlyOnceWith({ error, label: "fixture", texture });
    expect(h.uploader.stats()).toMatchObject({ publishedCompletionFailures: 1, lastPublishedCompletionFailure: { error, label: "fixture", texture } });
    expect(disposal.internals[0].dispose).not.toHaveBeenCalled();
    expect(h.reserved()).toBe(16);
    for (const completion of h.completions.slice(2)) completion.resolve(); await Promise.resolve();
    expect(h.reserved()).toBe(0); expect(h.release).toHaveBeenCalledTimes(6);
    texture.dispose(); expect(disposal.internals[0].dispose).toHaveBeenCalledOnce();
  });
  it("records a throwing host invalidation without blocking later completions or rejecting transferred loads", async () => {
    const h = harness(); const invalidationError = new Error("Host invalidation failed");
    h.invalidatePublishedSource.mockImplementation(() => { throw invalidationError; });
    const first = h.upload([h.bitmap(1, 1)]), second = h.upload([h.bitmap(1, 1)]);
    h.uploader.pump(); const textures = await Promise.all([first, second]);
    expect(h.reserved()).toBe(8);
    const firstError = new Error("First completion failed"), secondError = new Error("Second completion failed");
    h.completions[0].reject(firstError); await Promise.resolve();
    expect(h.uploader.stats().lastPublishedCompletionFailure).toEqual({ error: firstError, label: "fixture", texture: textures[0], invalidationError });
    expect(h.reserved()).toBe(4);
    h.completions[1].reject(secondError); await Promise.resolve();
    expect(h.invalidatePublishedSource).toHaveBeenCalledTimes(2);
    expect(h.uploader.stats()).toMatchObject({ publishedCompletionFailures: 2, lastPublishedCompletionFailure: { error: secondError, texture: textures[1], invalidationError } });
    expect(h.reserved()).toBe(0); expect(h.release).toHaveBeenCalledTimes(2);
    for (const internal of disposal.internals) expect(internal.dispose).not.toHaveBeenCalled();
    for (const texture of textures) texture.dispose();
  });
  it("captures rejected asynchronous host cleanup without letting an old callback replace the latest failure", async () => {
    const h = harness(); let rejectFirst!: (error: unknown) => void;
    h.invalidatePublishedSource.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject; }));
    const first = h.upload([h.bitmap(1, 1)]), second = h.upload([h.bitmap(1, 1)]);
    h.uploader.pump(); const textures = await Promise.all([first, second]);
    const firstError = new Error("First native failure"), secondError = new Error("Second native failure");
    h.completions[0].reject(firstError); await Promise.resolve();
    h.completions[1].reject(secondError); await Promise.resolve();
    rejectFirst(new Error("First host cleanup rejected")); await Promise.resolve();
    expect(h.uploader.stats().lastPublishedCompletionFailure).toEqual({ error: secondError, label: "fixture", texture: textures[1] });
    expect(h.reserved()).toBe(0); expect(h.invalidatePublishedSource).toHaveBeenCalledTimes(2);
    for (const texture of textures) texture.dispose();
  });
  it("exposes a rejected asynchronous cleanup for the current published failure", async () => {
    const h = harness(); const invalidationError = new Error("Async host cleanup rejected");
    h.invalidatePublishedSource.mockImplementationOnce(() => Promise.reject(invalidationError));
    const loading = h.upload([h.bitmap(1, 1)]); h.uploader.pump(); const texture = await loading;
    const error = new Error("Native failed after handoff"); h.completions[0].reject(error);
    await Promise.resolve(); await Promise.resolve();
    expect(h.uploader.stats().lastPublishedCompletionFailure).toEqual({ error, label: "fixture", texture, invalidationError });
    expect(h.reserved()).toBe(0); expect(disposal.internals[0].dispose).not.toHaveBeenCalled(); texture.dispose();
  });
  it("checks matching cube dimensions before allocating a device resource", () => {
    const h = harness();
    expect(() => h.upload([h.bitmap(4, 4), ...Array.from({ length: 5 }, () => h.bitmap(3, 3))], "cube")).toThrow("matching");
    expect(h.engine._textureHelper.createGPUTextureForInternalTexture).not.toHaveBeenCalled();
  });
  it("holds a throwing native-copy grant until completion without publishing a texture", async () => {
    const h = harness();
    h.engine._device.queue.copyExternalImageToTexture.mockImplementation(() => { throw new Error("Partial native copy"); });
    const loading = h.upload([h.bitmap(1, 1)]);
    h.uploader.pump();
    await expect(loading).rejects.toThrow("Partial native copy");
    expect(h.reserved()).toBe(4);
    h.completions[0].resolve(); await Promise.resolve();
    expect(h.reserved()).toBe(0);
  });
  it("rejects a final texture when querying completion throws and releases only on loss", async () => {
    const h = harness();
    h.engine._device.queue.onSubmittedWorkDone = () => { throw new Error("Completion unknown"); };
    const loading = h.upload([h.bitmap(1, 1)]);
    h.uploader.pump();
    await expect(loading).rejects.toThrow("Completion unknown");
    expect(h.reserved()).toBe(4);
    h.uploader.cancelAll("Device lost", { deviceLost: true });
    expect(h.reserved()).toBe(0);
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("settles all cancelled jobs and releases internals despite a throwing disposal observer", async () => {
    const h = harness();
    const first = h.upload([h.bitmap(4, 4)]); const second = h.upload([h.bitmap(4, 4)]);
    h.uploader.pump(); disposal.fail = true;
    h.uploader.cancelAll("Device lost", { deviceLost: true });
    await expect(first).rejects.toThrow("Device lost"); await expect(second).rejects.toThrow("Device lost");
    expect(disposal.internals).toHaveLength(2);
    for (const internal of disposal.internals) expect(internal.dispose).toHaveBeenCalledOnce();
    expect(h.reserved()).toBe(0);
    h.uploader.cancelAll("Device lost", { deviceLost: true }); h.completions[0].resolve(); await Promise.resolve();
    for (const internal of disposal.internals) expect(internal.dispose).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
  });
  it("publishes a cube only after all six caller-ordered layers and mip submission", async () => {
    const h = harness();
    const loading = h.upload(Array.from({ length: 6 }, () => h.bitmap(2, 2)), "cube");
    let published = false; void loading.then(() => { published = true; });
    h.uploader.pump(); await Promise.resolve();
    expect(published).toBe(false); expect(h.engine._textureHelper.generateCubeMipmaps).not.toHaveBeenCalled();
    h.completions[0].resolve(); h.completions[1].resolve(); await Promise.resolve();
    h.uploader.pump(); await Promise.resolve(); expect(published).toBe(false);
    h.completions[2].resolve(); h.completions[3].resolve(); await Promise.resolve();
    h.uploader.pump(); const texture = await loading;
    expect(h.engine._device.queue.copyExternalImageToTexture.mock.calls.map(call => (call[1] as { origin: { z: number } }).origin.z)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(h.engine._textureHelper.generateCubeMipmaps).toHaveBeenCalledOnce();
    expect(texture).toMatchObject({ kind: "cube", complete: true, gpuBytes: 120 });
    expect(h.reserved()).toBe(32);
    h.completions[4].resolve(); h.completions[5].resolve(); await Promise.resolve();
    expect(h.reserved()).toBe(0); expect(h.release).toHaveBeenCalledTimes(6); texture.dispose();
  });
  it("keeps the next queued job when the current native copy triggers its own abort", async () => {
    const h = harness(), next = new AbortController();
    const first = h.upload([h.bitmap(1, 1)]), second = h.upload([h.bitmap(1, 1)], "2d", next.signal);
    h.engine._device.queue.copyExternalImageToTexture.mockImplementationOnce(() => h.controller.abort(new Error("Replaced during copy")));
    h.uploader.pump();
    await expect(first).rejects.toThrow("Replaced during copy");
    const texture = await second; expect(texture.complete).toBe(true);
    expect(h.uploader.stats().queuedJobs).toBe(0); expect(h.reserved()).toBe(8);
    for (const completion of h.completions) completion.resolve(); await Promise.resolve();
    expect(h.reserved()).toBe(0); texture.dispose();
  });
  it("releases a current copy on synchronous observed device loss and refuses its retired backend", async () => {
    const h = harness(); const loading = h.upload([h.bitmap(1, 1)]);
    h.engine._device.queue.copyExternalImageToTexture.mockImplementation(() => h.uploader.cancelAll("Lost during copy", { deviceLost: true }));
    h.uploader.pump(); await expect(loading).rejects.toThrow("Lost during copy");
    expect(h.reserved()).toBe(0); expect(h.completions).toHaveLength(0);
    expect(() => h.upload([h.bitmap(1, 1)])).toThrow("lost"); expect(h.release).toHaveBeenCalledOnce();
  });
  it("cleans a partial native texture allocation before exposing a resource", () => {
    const h = harness();
    h.engine._textureHelper.createGPUTextureForInternalTexture.mockImplementation(() => { throw new Error("Allocation failed"); });
    expect(() => h.upload([h.bitmap(1, 1)])).toThrow("Allocation failed");
    expect(disposal.internals[0].dispose).toHaveBeenCalledOnce();
    expect(h.uploader.busy()).toBe(false); expect(h.reserved()).toBe(0);
  });
  it("preserves optional legacy map color metadata without changing default 360 output", async () => {
    const h = harness();
    const legacy = h.upload([h.bitmap(2, 2)], "2d", h.controller.signal, { useSRGBBuffer: false, gammaSpace: true });
    h.uploader.pump(); const legacyTexture = await legacy;
    expect(disposal.internals[0]).toMatchObject({ _useSRGBBuffer: false, invertY: false, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_BYTE, samplingMode: Constants.TEXTURE_TRILINEAR_SAMPLINGMODE });
    expect(legacyTexture.texture.gammaSpace).toBe(true); expect(legacyTexture.levels).toBe(2);
    expect(h.engine._device.queue.copyExternalImageToTexture.mock.calls[0][0]).toMatchObject({ flipY: false });
    for (const completion of h.completions) completion.resolve(); await Promise.resolve();
    const normal = h.upload([h.bitmap(2, 2)]); h.uploader.pump(); const normalTexture = await normal;
    expect(disposal.internals[1]._useSRGBBuffer).toBe(true); expect(normalTexture.texture.gammaSpace).toBe(false);
    expect(h.engine._textureHelper.generateMipmaps).toHaveBeenCalledTimes(2);
    for (const completion of h.completions) completion.resolve(); await Promise.resolve();
    legacyTexture.dispose(); normalTexture.dispose();
  });
  it("validates device dimensions and color flags before allocating", () => {
    const h = harness();
    expect(() => h.upload([h.bitmap(65, 1)])).toThrow("dimensions");
    expect(() => h.upload([h.bitmap(1, 1)], "2d", h.controller.signal, { useSRGBBuffer: "false", gammaSpace: true } as unknown as ImageUploadRequest["textureColor"])).toThrow("booleans");
    expect(h.engine._textureHelper.createGPUTextureForInternalTexture).not.toHaveBeenCalled();
  });
  it("requires the host invalidation callback before constructing a native upload adapter", () => {
    const h = harness();
    expect(() => createImageTextureUploader({ scene: { getEngine: () => h.engine } as unknown as Scene, limits: { bytesPerFrame: 32, outstandingBytes: 32 }, requestRender: h.requestRender, createStagingCanvas: () => { throw new Error("No canvas"); }, invalidatePublishedSource: undefined as never })).toThrow("host published-source invalidation port");
    expect(h.engine._textureHelper.createGPUTextureForInternalTexture).not.toHaveBeenCalled();
  });
  for (const cancel of ["abort", "cancelAll"] as const) {
    it(`does not submit to a texture cancelled by upload admission through ${cancel}`, async () => {
      const h = harness();
      const loading = h.uploader.upload({ kind: "2d", images: [h.bitmap(1, 1)], label: "admission", signal: h.controller.signal,
        reserveUpload(bytes) {
          const ticket = h.reserveUpload(bytes);
          if (cancel === "abort") h.controller.abort(new Error("Cancelled during admission"));
          else h.uploader.cancelAll("Cancelled during admission");
          return ticket;
        }, reserveDecodedStaging() { throw new Error("No GPU strip"); } });
      const rejected = expect(loading).rejects.toThrow("Cancelled during admission");
      h.uploader.pump(); await rejected;
      expect(h.engine._device.queue.copyExternalImageToTexture).not.toHaveBeenCalled();
      expect(h.completions).toHaveLength(0); expect(h.reserved()).toBe(0);
      expect(h.uploader.stats()).toMatchObject({ queuedJobs: 0, outstandingBytes: 0, uploadedBytes: 0 });
      expect(h.release).toHaveBeenCalledOnce(); expect(disposal.internals[0].dispose).toHaveBeenCalledOnce();
    });
  }
});
