import { beforeEach, describe, expect, it, vi } from "vitest";
import { Constants, type Scene, type InternalTexture } from "@babylonjs/core";
import { createTextureDevicePorts } from "../src/babylon/textureDevice.js";
import { createCanvasTextureDevicePorts } from "../src/babylon/canvasTextureDevice.js";
import { createTextureTransferTracker } from "../src/babylon/textureTransfers.js";

const state = vi.hoisted(() => ({ disposeFails: false }));
beforeEach(() => { state.disposeFails = false; });
vi.mock("@babylonjs/core", async importOriginal => {
  const actual = await importOriginal<typeof import("@babylonjs/core")>();
  class MockTexture {
    name = "fixture";
    constructor(readonly scene: Scene, private internal: { dispose(): void } | null) {}
    getScene() { return this.scene; }
    getInternalTexture() { return this.internal; }
    releaseInternalTexture() { this.internal?.dispose(); this.internal = null; }
    dispose() { if (state.disposeFails) throw new Error("Disposal observer failed"); this.releaseInternalTexture(); }
  }
  class RawTexture extends MockTexture {
    constructor(data: Uint8Array | null, width: number, height: number, format: number, scene: Scene, mipmaps: boolean, flip: boolean, sampling: number, type: number) {
      super(scene, (scene.getEngine() as unknown as { createRawTexture(...args: unknown[]): InternalTexture }).createRawTexture(data, width, height, format, mipmaps, flip, sampling, undefined, type));
    }
  }
  class DynamicTexture extends MockTexture {
    constructor(name: string, readonly canvas: HTMLCanvasElement | OffscreenCanvas, scene: Scene, readonly mipmaps: boolean) {
      super(scene, (scene.getEngine() as unknown as { createDynamicTexture(width: number, height: number, mipmaps: boolean): InternalTexture }).createDynamicTexture(canvas.width, canvas.height, mipmaps));
      this.name = name;
    }
    update(flip: boolean) {
      (this.scene.getEngine() as unknown as { updateDynamicTexture(...args: unknown[]): void }).updateDynamicTexture(this.getInternalTexture(), this.canvas, flip, this.mipmaps);
    }
  }
  return { ...actual, RawTexture, DynamicTexture };
});

function harness(gpu = false) {
  const completions: (() => void)[] = [];
  const gl = {
    UNPACK_FLIP_Y_WEBGL: 1, UNPACK_ALIGNMENT: 2, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 3, UNPACK_COLORSPACE_CONVERSION_WEBGL: 4,
    TEXTURE_2D: 5, TEXTURE_CUBE_MAP: 6, SYNC_GPU_COMMANDS_COMPLETE: 7, TIMEOUT_EXPIRED: 8, WAIT_FAILED: 9, ALREADY_SIGNALED: 10, CONDITION_SATISFIED: 11,
    getParameter: vi.fn((key: number) => key === 2 ? 8 : key === 4 ? 99 : true), pixelStorei: vi.fn(),
    fenceSync: vi.fn(() => ({})), flush: vi.fn(), clientWaitSync: vi.fn(() => 8), deleteSync: vi.fn(), finish: vi.fn(),
  };
  const internals: { dispose: ReturnType<typeof vi.fn>; getEngine(): unknown; isCube: boolean }[] = [];
  const engine = {
    isWebGPU: gpu, webGLVersion: gpu ? 0 : 2, _gl: gl, getCaps: () => ({ maxTextureSize: 64 }),
    _device: { queue: { onSubmittedWorkDone: () => new Promise<void>(resolve => completions.push(resolve)) } },
    _bindTextureDirectly: vi.fn(), _unpackFlipY: vi.fn(), updateTextureData: vi.fn(), updateDynamicTexture: vi.fn(),
    createRawTexture: vi.fn(() => makeInternal()), createDynamicTexture: vi.fn(() => makeInternal()),
  };
  const makeInternal = () => { const internal = { dispose: vi.fn(), getEngine: (): unknown => engine, isCube: false }; internals.push(internal); return internal; };
  const scene = { getEngine: () => engine } as unknown as Scene;
  const releases: ReturnType<typeof vi.fn>[] = [];
  const admit = vi.fn(() => { const release = vi.fn(); releases.push(release); return { release }; });
  const tracker = createTextureTransferTracker({ scene, admit, requestRender() {} });
  const device = createTextureDevicePorts({ scene, transfer: tracker.transfer });
  const request = { scene, data: new Uint8Array(64), width: 4, height: 4, format: Constants.TEXTUREFORMAT_RGBA, mipmaps: false, invertY: false, samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE, type: Constants.TEXTURETYPE_UNSIGNED_BYTE };
  return { scene, engine, gl, completions, internals, releases, admit, tracker, device, request };
}

describe("generic raw texture device", () => {
  it("admits allocation bytes and holds their charge until the same GPU completes", async () => {
    const h = harness(true); const texture = h.device.createRawTexture(h.request);
    expect(h.admit).toHaveBeenCalledWith(64, "raw texture allocation");
    expect(h.releases[0]).not.toHaveBeenCalled();
    h.completions[0](); await Promise.resolve();
    expect(h.releases[0]).toHaveBeenCalledOnce(); texture.dispose(); h.tracker.dispose();
    expect(h.internals[0].dispose).toHaveBeenCalledOnce();
  });
  it("restores cube pixel state after a throwing native update and retains its grant", () => {
    const h = harness();
    const texture = h.device.createRawTexture({ ...h.request, data: null });
    const internal = texture.getInternalTexture()!; internal.isCube = true;
    h.engine.updateTextureData.mockImplementation(() => { throw new Error("Native cube update failed"); });
    expect(() => h.device.updateTextureData(internal, new Uint8Array(16), 1, 2, 2, 2, 5, 1, true)).toThrow("Native cube update failed");
    expect(h.engine.updateTextureData).toHaveBeenCalledWith(internal, expect.any(Uint8Array), 1, 2, 2, 2, 5, 1, true);
    expect(h.gl.pixelStorei).toHaveBeenCalledWith(h.gl.UNPACK_ALIGNMENT, 8);
    expect(h.engine._unpackFlipY).toHaveBeenLastCalledWith(true);
    expect(h.engine._bindTextureDirectly).toHaveBeenLastCalledWith(h.gl.TEXTURE_CUBE_MAP, null, true);
    expect(h.releases[0]).not.toHaveBeenCalled();
    h.gl.clientWaitSync.mockReturnValue(10); h.tracker.pump();
    expect(h.releases[0]).toHaveBeenCalledOnce(); texture.dispose(); h.tracker.dispose();
  });
  it("refuses foreign scenes and oversized allocations before touching native storage", () => {
    const h = harness();
    expect(() => h.device.createRawTexture({ ...h.request, scene: {} as Scene })).toThrow("different");
    expect(() => h.device.createRawTexture({ ...h.request, width: 65 })).toThrow("dimensions");
    expect(h.engine.createRawTexture).not.toHaveBeenCalled(); expect(h.admit).not.toHaveBeenCalled();
    h.tracker.dispose();
  });
  it("disposes an unreturned allocation if post-submission tracking throws", () => {
    const h = harness();
    h.gl.flush.mockImplementation(() => { throw new Error("Flush failed"); });
    expect(() => h.device.createRawTexture(h.request)).toThrow("Flush failed");
    expect(h.internals[0].dispose).toHaveBeenCalledOnce();
    expect(h.releases[0]).not.toHaveBeenCalled(); h.tracker.deviceLost();
    expect(h.releases[0]).toHaveBeenCalledOnce(); h.tracker.dispose();
  });
  it("disposes raw allocation when state restoration throws after construction", () => {
    const h = harness();
    h.gl.pixelStorei.mockImplementationOnce(() => { throw new Error("Restore failed"); });
    expect(() => h.device.createRawTexture(h.request)).toThrow("Restore failed");
    expect(h.internals[0].dispose).toHaveBeenCalledOnce();
    h.tracker.deviceLost(); expect(h.releases[0]).toHaveBeenCalledOnce(); h.tracker.dispose();
  });
});

describe("host-realm canvas texture device", () => {
  it("supplies the exact canvas before allocation and preserves flip/mipmap policy", async () => {
    const h = harness(true);
    const canvas = { width: 0, height: 0 } as OffscreenCanvas;
    const createCanvas = vi.fn(() => canvas);
    const device = createCanvasTextureDevicePorts({ scene: h.scene, createCanvas, transfer: h.tracker.transfer });
    const texture = device.createTexture({ name: "atlas", width: 8, height: 4, mipmaps: true });
    expect(createCanvas).toHaveBeenCalledExactlyOnceWith(8, 4);
    expect(h.engine.createDynamicTexture).toHaveBeenCalledExactlyOnceWith(8, 4, true);
    expect(h.admit).not.toHaveBeenCalled();
    device.updateTexture(texture, true);
    expect(h.engine.updateDynamicTexture).toHaveBeenCalledWith(texture.getInternalTexture(), canvas, true, true);
    expect(h.admit).toHaveBeenCalledWith(128, "atlas canvas texture update");
    expect(h.releases[0]).not.toHaveBeenCalled(); h.completions[0](); await Promise.resolve();
    expect(h.releases[0]).toHaveBeenCalledOnce();
    state.disposeFails = true;
    expect(() => texture.dispose()).toThrow("Disposal observer failed"); texture.dispose();
    expect(h.internals[0].dispose).toHaveBeenCalledOnce(); h.tracker.dispose();
  });
  it("refuses foreign/disposed textures and canvas dimensions outside the same device", () => {
    const h = harness(); const createCanvas = vi.fn(() => ({ width: 0, height: 0 } as OffscreenCanvas));
    const device = createCanvasTextureDevicePorts({ scene: h.scene, createCanvas, transfer: h.tracker.transfer });
    const other = createCanvasTextureDevicePorts({ scene: h.scene, createCanvas, transfer: h.tracker.transfer });
    expect(() => device.createTexture({ name: "bad", width: 65, height: 1, mipmaps: false })).toThrow("dimensions");
    expect(createCanvas).not.toHaveBeenCalled();
    const texture = other.createTexture({ name: "foreign", width: 4, height: 4, mipmaps: false });
    expect(() => device.updateTexture(texture, false)).toThrow("another");
    texture.dispose(); expect(() => other.updateTexture(texture, false)).toThrow("disposed");
    expect(h.admit).not.toHaveBeenCalled(); h.tracker.dispose();
  });
  it("retains a partial throwing canvas copy until GPU completion", async () => {
    const h = harness(true);
    const device = createCanvasTextureDevicePorts({ scene: h.scene, createCanvas: () => ({ width: 4, height: 4 } as OffscreenCanvas), transfer: h.tracker.transfer });
    const texture = device.createTexture({ name: "compass", width: 4, height: 4, mipmaps: false });
    h.engine.updateDynamicTexture.mockImplementation(() => { throw new Error("Partial canvas copy"); });
    expect(() => device.updateTexture(texture, false)).toThrow("Partial canvas copy");
    expect(h.releases[0]).not.toHaveBeenCalled(); h.completions[0](); await Promise.resolve();
    expect(h.releases[0]).toHaveBeenCalledOnce(); texture.dispose(); h.tracker.dispose();
  });
  it("disposes canvas allocation if post-construction GL state restoration fails", () => {
    const h = harness();
    const device = createCanvasTextureDevicePorts({ scene: h.scene, createCanvas: () => ({ width: 4, height: 4 } as OffscreenCanvas), transfer: h.tracker.transfer });
    h.gl.pixelStorei.mockImplementationOnce(() => { throw new Error("Restore failed"); });
    expect(() => device.createTexture({ name: "compass", width: 4, height: 4, mipmaps: true })).toThrow("Restore failed");
    expect(h.internals[0].dispose).toHaveBeenCalledOnce(); expect(h.admit).not.toHaveBeenCalled(); h.tracker.dispose();
  });
});
