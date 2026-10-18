import { FreeCamera, NullEngine, Observable, Scene, Vector3, type WebGPUEngine } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { probeWebGpuPresentation, watchWebGpuPresentation } from "../src/babylon/webgpuPresentationProbe.js";

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

describe("watching the page's canvas after a skipped probe", () => {
  function watched(policy = { frames: 2, settleFrameCount: 1, settleMs: 5 }) {
    const listeners = new Set<EventListener>();
    const device = { addEventListener: vi.fn((_name: string, callback: EventListener) => { listeners.add(callback); }),
      removeEventListener: vi.fn((_name: string, callback: EventListener) => { listeners.delete(callback); }) };
    const engine = { device, onEndFrameObservable: new Observable<unknown>(), onDisposeObservable: new Observable<unknown>() };
    let settle: () => void = () => {};
    const delay = vi.fn(() => new Promise<void>(resolve => { settle = resolve; }));
    const onFailure = vi.fn();
    const stop = watchWebGpuPresentation(engine as unknown as WebGPUEngine, { nextFrame: async () => undefined, delay, policy }, onFailure);
    const error = (message: string) => { for (const listener of [...listeners]) listener({ error: { message } } as unknown as Event); };
    const frame = () => engine.onEndFrameObservable.notifyObservers(null);
    return { engine, listeners, delay, onFailure, stop, error, frame, settle: () => settle() };
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  it("reports the first presentation error once, and ignores the scene's own errors", () => {
    const watch = watched();
    watch.error("Binding size is smaller than the minimum binding size of the layout");
    expect(watch.onFailure).not.toHaveBeenCalled();
    watch.error("Invalid Texture: importMemory failed");
    watch.error("Destroyed texture used in a submit");
    expect(watch.onFailure).toHaveBeenCalledTimes(1);
    expect(watch.onFailure).toHaveBeenCalledWith(["Invalid Texture: importMemory failed"]);
    expect(watch.listeners.size).toBe(0);
  });

  it("stops listening after the probe's frames and its settle wait", async () => {
    const watch = watched();
    watch.frame();
    expect(watch.delay).not.toHaveBeenCalled();
    watch.frame();
    await flush();
    expect(watch.delay).toHaveBeenCalledWith(5);
    watch.error("swapchain lost");
    expect(watch.onFailure).toHaveBeenCalledTimes(1);
    watch.onFailure.mockClear();
    const late = watched();
    late.frame(); late.frame();
    await flush();
    late.settle();
    await flush();
    expect(late.listeners.size).toBe(0);
    late.error("swapchain lost");
    expect(late.onFailure).not.toHaveBeenCalled();
    expect(late.engine.onEndFrameObservable.hasObservers()).toBe(false);
  });

  it("stops when the engine is disposed or when called", () => {
    const disposed = watched();
    disposed.engine.onDisposeObservable.notifyObservers(null);
    expect(disposed.listeners.size).toBe(0);
    expect(disposed.engine.onEndFrameObservable.hasObservers()).toBe(false);
    const stopped = watched();
    stopped.stop();
    stopped.error("swapchain lost");
    expect(stopped.onFailure).not.toHaveBeenCalled();
    expect(stopped.engine.onDisposeObservable.hasObservers()).toBe(false);
  });
});
