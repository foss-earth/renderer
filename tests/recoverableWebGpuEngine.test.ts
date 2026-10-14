import { afterEach, describe, expect, it, vi } from "vitest";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree.js";

vi.mock("@babylonjs/core", () => ({
  WebGPUEngine: class {
    _device: object = {};
    _isDisposed = false;
    _contextWasLost = true;
    _depthCullingState = { depthTest: false, depthFunc: 123, depthMask: false };
    _stencilState = { stencilTest: true };
    _uniformBuffers: { name: string }[] = [];
    scenes: unknown[] = [];
    _virtualScenes: unknown[] = [];
    events: string[] = [];
    onContextRestoredObservable = { notifyObservers: vi.fn() };
    get isDisposed() { return this._isDisposed; }
    _clearEmptyResources() { this.events.push("clear"); }
    _rebuildGraphicsResources() { this.events.push("graphics"); this._rebuildBuffers(); }
    _rebuildBuffers() { this.events.push("buffers"); }
  },
}));

import { RecoverableWebGpuEngine } from "../src/babylon/recoverableWebGpuEngine.js";

class TestEngine extends RecoverableWebGpuEngine {
  restore(initialize: () => void) { this._restoreEngineAfterContextLost(initialize); }
  rebuildBuffers() { this._rebuildBuffers(); }
}

function fixture() {
  const engine = new TestEngine(null as never);
  const state = engine as unknown as {
    _device: { destroy?: () => void };
    _isDisposed: boolean;
    _contextWasLost: boolean;
    events: string[];
  };
  const error = vi.fn(); engine.onRestoreError = error;
  return { engine, state, error };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("owned WebGPU device restoration", () => {
  it("roots the initialized pipeline helper in the new cache before graphics are rebuilt", async () => {
    vi.useFakeTimers();
    const device = { limits: { maxVertexBufferArrayStride: 2048 } };
    const tree = () => new WebGPUCacheRenderPipelineTree(device as never, null as never);
    const root = (pipeline: WebGPUCacheRenderPipelineTree) => (pipeline as unknown as { _nodeStack: object[] })._nodeStack[0];
    const oldRoot = root(tree()), { engine, state } = fixture();
    let initializedRoot: object | null = null;
    engine.restore(async () => { state._device = {}; initializedRoot = root(tree()); });
    await vi.runAllTimersAsync();
    expect(initializedRoot).not.toBe(oldRoot);
    expect(initializedRoot).toBe(root(tree()));
    expect(engine.onContextRestoredObservable.notifyObservers).toHaveBeenCalledOnce();
  });

  it("awaits initialization before rebuilding, preserves state and coalesces a duplicate loss", async () => {
    vi.useFakeTimers();
    const { engine, state } = fixture(), wait = deferred();
    const initialize = vi.fn(async () => {
      state.events.push("initialize");
      await wait.promise;
      state._device = {};
      engine._depthCullingState.depthTest = true;
      engine._depthCullingState.depthFunc = 515;
      engine._depthCullingState.depthMask = true;
      engine._stencilState.stencilTest = false;
      state.events.push("initialized");
    });
    engine.restore(initialize); engine.restore(initialize);
    await vi.advanceTimersByTimeAsync(0);
    expect(initialize).toHaveBeenCalledOnce();
    expect(state.events).toEqual(["clear", "initialize"]);
    expect(engine.onContextRestoredObservable.notifyObservers).not.toHaveBeenCalled();
    wait.resolve(); await vi.runAllTimersAsync();
    expect(state.events).toEqual(["clear", "initialize", "initialized", "graphics", "buffers"]);
    expect(engine._depthCullingState).toEqual({ depthTest: false, depthFunc: 123, depthMask: false });
    expect(engine._stencilState.stencilTest).toBe(true);
    expect(engine.onContextRestoredObservable.notifyObservers).toHaveBeenCalledOnce();
    expect(state._contextWasLost).toBe(false);
  });

  it("restores a second lost device without retaining the first device's bindings", async () => {
    vi.useFakeTimers();
    const { engine, state } = fixture();
    const reset = vi.fn();
    engine.scenes = [{ meshes: [{ subMeshes: [{ _drawWrappers: ["old"] }] }], materials: [{ _materialContext: { reset } }], resetCachedMaterial() {}, _rebuildGeometries() {} }] as never;
    engine._uniformBuffers = [{ name: "leftOver material" }, { name: "host" }] as never;
    for (let i = 0; i < 2; i++) {
      state._contextWasLost = true;
      engine.restore(async () => { state._device = {}; });
      await vi.runAllTimersAsync();
    }
    expect(engine.onContextRestoredObservable.notifyObservers).toHaveBeenCalledTimes(2);
    expect(reset).toHaveBeenCalledTimes(2);
    expect(engine.scenes[0].meshes[0].subMeshes[0]._drawWrappers).toEqual([]);
    expect(engine._uniformBuffers.map(buffer => buffer.name)).toEqual(["host"]);
    expect(state.events.filter(event => event === "graphics")).toHaveLength(2);
  });

  it("queues a replacement lost during initialization and publishes only the surviving device", async () => {
    vi.useFakeTimers();
    const { engine, state } = fixture();
    engine.restore(async () => {
      state._device = {};
      engine._depthCullingState.depthTest = true;
      engine._depthCullingState.depthFunc = 515;
      engine._stencilState.stencilTest = false;
      engine.restore(async () => {
        state._device = {};
        engine._depthCullingState.depthFunc = 515;
      });
    });
    await vi.runAllTimersAsync();
    expect(state.events.filter(event => event === "graphics")).toHaveLength(1);
    expect(engine.onContextRestoredObservable.notifyObservers).toHaveBeenCalledOnce();
    expect(engine._depthCullingState).toEqual({ depthTest: false, depthFunc: 123, depthMask: false });
    expect(engine._stencilState.stencilTest).toBe(true);
  });

  it("keeps a loss raised by a restore subscriber and preserves settings through the queued restore", async () => {
    vi.useFakeTimers();
    const { engine, state } = fixture();
    vi.mocked(engine.onContextRestoredObservable.notifyObservers).mockImplementationOnce(() => {
      state._contextWasLost = true;
      engine.restore(async () => { state._device = {}; engine._depthCullingState.depthFunc = 515; });
      expect(state._contextWasLost).toBe(true);
      return true;
    });
    engine.restore(async () => { state._device = {}; });
    await vi.runAllTimersAsync();
    expect(engine.onContextRestoredObservable.notifyObservers).toHaveBeenCalledTimes(2);
    expect(engine._depthCullingState.depthFunc).toBe(123);
    expect(state._contextWasLost).toBe(false);
  });

  it("does no deferred initialization after disposal, and retires a replacement arriving after disposal", async () => {
    vi.useFakeTimers();
    const before = fixture(), initialize = vi.fn();
    before.engine.restore(initialize); before.state._isDisposed = true;
    await vi.runAllTimersAsync();
    expect(initialize).not.toHaveBeenCalled();
    const { engine, state } = fixture(), wait = deferred(), destroy = vi.fn();
    engine.restore(async () => { await wait.promise; state._device = { destroy }; });
    await vi.advanceTimersByTimeAsync(0);
    state._isDisposed = true; wait.resolve(); await vi.runAllTimersAsync();
    expect(destroy).toHaveBeenCalledOnce();
    expect(state.events).toEqual(["clear"]);
    expect(engine.onContextRestoredObservable.notifyObservers).not.toHaveBeenCalled();
  });

  it("reports initialization or rebuild failure without announcing restoration", async () => {
    vi.useFakeTimers();
    for (const phase of ["clear", "initialize", "rebuild"]) {
      const { engine, state, error } = fixture(), failure = new Error(`${phase} refused`);
      if (phase === "clear") vi.spyOn(engine as never as { _clearEmptyResources(): void }, "_clearEmptyResources").mockImplementation(() => { throw failure; });
      if (phase === "rebuild") vi.spyOn(engine as never as { _rebuildGraphicsResources(): void }, "_rebuildGraphicsResources").mockImplementation(() => { throw failure; });
      engine.restore(async () => { if (phase === "initialize") throw failure; state._device = {}; });
      await vi.runAllTimersAsync();
      expect(error).toHaveBeenCalledWith(failure);
      expect(state._contextWasLost).toBe(true);
      expect(engine.onContextRestoredObservable.notifyObservers).not.toHaveBeenCalled();
    }
  });

  it("recreates actual scene and virtual-scene geometry index and vertex buffers", async () => {
    const { NullEngine, Scene, Mesh, VertexData } = await vi.importActual<typeof import("@babylonjs/core")>("@babylonjs/core");
    const device = new NullEngine(), scene = new Scene(device), virtual = new Scene(device);
    const geometries = [scene, virtual].map(host => {
      const mesh = new Mesh("retained geometry", host), data = new VertexData();
      data.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0]; data.indices = [0, 1, 2]; data.applyToMesh(mesh);
      return mesh.geometry!;
    });
    const before = geometries.map(geometry => ({ index: geometry.getIndexBuffer(), vertex: geometry.getVertexBuffer("position")!.getBuffer() }));
    const { engine } = fixture(); engine.scenes = [scene]; engine._virtualScenes = [virtual];
    try {
      engine.rebuildBuffers();
      for (let i = 0; i < geometries.length; i++) {
        expect(geometries[i].getIndexBuffer()).not.toBe(before[i].index);
        expect(geometries[i].getVertexBuffer("position")!.getBuffer()).not.toBe(before[i].vertex);
      }
    } finally { scene.dispose(); virtual.dispose(); device.dispose(); }
  });
});
