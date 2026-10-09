import { FreeCamera, NullEngine, Scene, Vector3, type WebGPUEngine } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { probeWebGpuPresentation } from "../src/babylon/webgpuPresentationProbe.js";

describe("presentation probe host waits and cleanup", () => {
  it("brackets requested probe frames, observes asynchronous errors and releases camera/listener", async () => {
    const nullEngine = new NullEngine();
    const scene = new Scene(nullEngine);
    let listener: EventListener | undefined;
    const remove = vi.fn();
    const engine = {
      resize: vi.fn(), beginFrame: vi.fn(), endFrame: vi.fn(),
      device: { addEventListener: vi.fn((_name: string, callback: EventListener) => { listener = callback; }), removeEventListener: remove },
    } as unknown as WebGPUEngine;
    const render = vi.spyOn(scene, "render").mockImplementation(() => undefined);
    const nextFrame = vi.fn(async () => { listener?.({ error: { message: "invalid TextureView resolve target" } } as unknown as Event); });
    const delay = vi.fn(async () => undefined);
    try {
      const result = await probeWebGpuPresentation(engine, scene, { nextFrame, delay, policy: { frames: 2, settleFrameCount: 1, settleMs: 5 } });
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(2);
      expect(engine.beginFrame).toHaveBeenCalledTimes(2);
      expect(engine.endFrame).toHaveBeenCalledTimes(2);
      expect(render).toHaveBeenCalledTimes(2);
      expect(nextFrame).toHaveBeenCalledTimes(2);
      expect(delay).toHaveBeenCalledWith(5);
      expect(scene.activeCamera).toBeNull();
      expect(scene.cameras).toHaveLength(0);
      expect(remove).toHaveBeenCalledWith("uncapturederror", listener);
    } finally { scene.dispose(); nullEngine.dispose(); }
  });

  it("returns a synchronous render failure and still releases the probe camera", async () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    vi.spyOn(scene, "render").mockImplementation(() => { throw new Error("swapchain submission failed"); });
    try {
      const result = await probeWebGpuPresentation(engine as unknown as WebGPUEngine, scene, { nextFrame: async () => undefined, delay: async () => undefined });
      expect(result).toEqual({ ok: false, errors: ["swapchain submission failed"] });
      expect(scene.cameras).toHaveLength(0);
      expect(scene.activeCamera).toBeNull();
      // The scene remains usable by its owner after the probe's camera leaves.
      new FreeCamera("host", Vector3.Zero(), scene);
      expect(scene.cameras).toHaveLength(1);
    } finally { scene.dispose(); engine.dispose(); }
  });
});
