import { describe, expect, it, vi } from "vitest";
import { Constants, type Scene } from "@babylonjs/core";
import { createImageRegionDevicePorts } from "../src/babylon/imageRegionDevice.js";
import { createTextureTransferTracker } from "../src/babylon/textureTransfers.js";

vi.mock("@babylonjs/core", async importOriginal => ({
  ...await importOriginal<typeof import("@babylonjs/core")>(),
  InternalTexture: class { _hardwareTexture = { underlyingResource: {} }; dispose = vi.fn(); },
  BaseTexture: class {
    constructor(_scene: unknown, private internal: { dispose(): void } | null) {}
    getInternalTexture() { return this.internal; }
    releaseInternalTexture() { this.internal?.dispose(); this.internal = null; }
    dispose() { this.releaseInternalTexture(); }
  },
}));
function harness(gpu: boolean) {
  const completions: (() => void)[] = [];
  const gl = {
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 1, UNPACK_COLORSPACE_CONVERSION_WEBGL: 2, UNPACK_FLIP_Y_WEBGL: 3,
    TEXTURE_2D: 4, RGBA: 5, UNSIGNED_BYTE: 6, NONE: 0, UNPACK_ALIGNMENT: 7,
    getParameter: vi.fn((parameter: number) => parameter === 2 ? 99 : parameter === 7 ? 8 : true), pixelStorei: vi.fn(), texSubImage2D: vi.fn(),
  };
  const engine = {
    isWebGPU: gpu, webGLVersion: 1, _gl: gl, getCaps: () => ({ maxTextureSize: 64 }),
    _device: { queue: { copyExternalImageToTexture: vi.fn(), onSubmittedWorkDone: () => new Promise<void>(resolve => completions.push(resolve)) } },
    _textureHelper: { createGPUTextureForInternalTexture: vi.fn() },
    createRawTexture: vi.fn(() => ({ dispose: vi.fn() })), updateRawTexture: vi.fn(), _bindTextureDirectly: vi.fn(), _unpackFlipY: vi.fn(),
  };
  const scene = { getEngine: () => engine } as unknown as Scene;
  const tracker = createTextureTransferTracker({ scene, admit: () => { throw new Error("Already admitted"); }, requestRender() {} });
  const device = createImageRegionDevicePorts({ scene, track: tracker.track });
  const texture = device.createTexture({ width: 8, height: 8, label: "atlas", srgb: true, samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE });
  return { engine, gl, device, texture, completions, tracker };
}
describe("borrowed renderer image region device", () => {
  it("preserves region geometry/sRGB and retains a partial GPU copy until completion", async () => {
    const h = harness(true); const release = vi.fn(); const image = { width: 2, height: 2 } as ImageBitmap;
    h.engine._device.queue.copyExternalImageToTexture.mockImplementation(() => { throw new Error("copy failed"); });
    expect(() => h.device.copyImage(h.texture, image, 4, 2, { release })).toThrow("copy failed");
    expect(h.engine._device.queue.copyExternalImageToTexture.mock.calls[0][1]).toMatchObject({ origin: { x: 4, y: 2, z: 0 }, colorSpace: "srgb", premultipliedAlpha: false });
    expect(release).not.toHaveBeenCalled(); h.completions[0](); await Promise.resolve();
    expect(release).toHaveBeenCalledOnce(); h.texture.dispose(); h.tracker.dispose();
  });
  it("restores all GL pixel state and binding after a throwing native copy", () => {
    const h = harness(false); const release = vi.fn();
    h.gl.texSubImage2D.mockImplementation(() => { throw new Error("copy failed"); });
    expect(() => h.device.copyImage(h.texture, { width: 2, height: 2 } as ImageBitmap, 0, 0, { release })).toThrow("copy failed");
    expect(h.gl.pixelStorei).toHaveBeenLastCalledWith(h.gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, 99);
    expect(h.engine._unpackFlipY).toHaveBeenLastCalledWith(true);
    expect(h.engine._bindTextureDirectly).toHaveBeenLastCalledWith(h.gl.TEXTURE_2D, null, true);
    expect(release).toHaveBeenCalledOnce(); h.texture.dispose(); h.tracker.dispose();
  });
  it("releases invalid-copy grants before submission and rejects foreign/disposed textures", () => {
    const h = harness(true); const release = vi.fn();
    expect(() => h.device.copyImage(h.texture, { width: 4, height: 4 } as ImageBitmap, 6, 6, { release })).toThrow("outside");
    expect(release).toHaveBeenCalledOnce();
    expect(h.engine._device.queue.copyExternalImageToTexture).not.toHaveBeenCalled();
    h.texture.dispose();
    expect(() => h.device.copyBytes(h.texture, new Uint8Array(256), { release })).toThrow("disposed");
    expect(release).toHaveBeenCalledTimes(2); h.tracker.dispose();
  });
  it("restores GL raw-copy state when Babylon's raw update throws", () => {
    const h = harness(false); const release = vi.fn();
    h.engine.updateRawTexture.mockImplementation(() => { throw new Error("raw copy failed"); });
    expect(() => h.device.copyBytes(h.texture, new Uint8Array(256), { release })).toThrow("raw copy failed");
    expect(h.gl.pixelStorei).toHaveBeenCalledWith(h.gl.UNPACK_ALIGNMENT, 8);
    expect(h.engine._unpackFlipY).toHaveBeenLastCalledWith(true);
    expect(h.engine._bindTextureDirectly).toHaveBeenLastCalledWith(h.gl.TEXTURE_2D, null, true);
    expect(release).toHaveBeenCalledOnce(); h.texture.dispose(); h.tracker.dispose();
  });
});
