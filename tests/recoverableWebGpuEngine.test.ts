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
    // The canvas's passes and attachments, as Babylon 8.56.2's WebGPU engine makes them.
    _currentRenderTarget: object | null = null;
    _currentRenderPass: object | null = null;
    _scissorCached = { x: 0, y: 0, z: 0, w: 0 };
    _clearStencilValue = 0;
    useReverseDepthBuffer = true;
    snapshotRendering = false;
    compatibilityMode = true;
    _stencilStateComposer = { enabled: false, wanted: false, apply() { this.enabled = this.wanted; } };
    width = 1;
    canvas = { passes: 0, depth: "zero", stencil: "zero", draws: [] as string[], queries: [] as number[] };
    setDepthFunctionToGreaterOrEqual() { this._depthCullingState.depthFunc = 518; }
    enableScissor(x: number, y: number, width: number, height: number) { this._scissorCached = { x, y, z: width, w: height }; }
    disableScissor() { this._scissorCached = { x: 0, y: 0, z: 0, w: 0 }; }
    startMainRenderPass(clears: boolean, color: unknown, depth: boolean, stencil: boolean) {
      if (this.useReverseDepthBuffer) this.setDepthFunctionToGreaterOrEqual();
      this._currentRenderPass = {};
      this.canvas.passes += 1;
      if (clears && color) this.canvas.draws.push("color cleared");
      if (clears && depth) this.canvas.depth = "cleared";
      if (clears && stencil) this.canvas.stencil = `cleared to ${this._clearStencilValue}`;
    }
    clear(color: unknown, backBuffer: boolean, depth: boolean, stencil = false, value = 0) {
      if (stencil) this._clearStencilValue = value;
      if (this._currentRenderTarget) return;
      const scissor = Object.values(this._scissorCached).some(side => side !== 0);
      if (!this._currentRenderPass || !scissor) this.startMainRenderPass(!scissor, backBuffer ? color : null, depth, stencil);
      if (scissor && depth) this.canvas.depth += " + scissored clear";
      if (scissor && stencil) this.canvas.stencil += ` + scissored clear to ${value}`;
    }
    draw(name: string) {
      this._stencilStateComposer.apply();
      if (this._currentRenderTarget) return;
      if (!this._currentRenderPass) this.startMainRenderPass(false, null, false, false);
      const { depthTest, depthFunc, depthMask } = this._depthCullingState, stencil = this._stencilStateComposer.enabled;
      // Greater or equal passes everywhere on depth cleared to 0, as no test does.
      const untested = !depthTest || (depthFunc ?? 519) === 519 || (depthFunc === 518 && this.canvas.depth === "cleared");
      this.canvas.draws.push(`${name}: depth ${untested ? "untested" : `tested ${depthFunc} on ${this.canvas.depth}`}${depthMask ? ", written" : ""}`
        + `${stencil ? `, stencil on ${this.canvas.stencil}` : ""}, scissor ${Object.values(this._scissorCached).join()}, stencil value ${this._clearStencilValue}`);
      if (depthMask) this.canvas.depth += ` + ${name}`;
      if (stencil) this.canvas.stencil += ` + ${name}`;
    }
    drawElementsType(fillMode: number, start: number, count: number) { this.draw(`elements ${fillMode} ${start} ${count}`); }
    drawArraysType(fillMode: number, start: number, count: number) { this.draw(`arrays ${fillMode} ${start} ${count}`); }
    beginOcclusionQuery() { this.canvas.queries.push(this.canvas.passes); return true; }
    setSize(width: number) {
      if (width === this.width) return false;
      this.width = width; this._currentRenderPass = null; this.canvas.passes += 1;
      this.canvas.depth = "cleared on resize"; this.canvas.stencil = "zero on resize";
      return true;
    }
    endFrame() { this._currentRenderPass = null; }
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

describe("held depth clears", () => {
  type Canvas = { passes: number; draws: string[]; queries: number[] };
  type Engine = TestEngine & { canvas: Canvas; endFrame(): void; _stencilStateComposer: { wanted: boolean } };
  const color = { r: 0, g: 0, b: 0, a: 1 };
  const state = (engine: Engine, depthTest: boolean, depthFunc: number, depthMask: boolean) => Object.assign(engine._depthCullingState, { depthTest, depthFunc, depthMask });
  const terrain = (engine: Engine) => { state(engine, true, 518, true); engine.drawElementsType(0, 0, 6); };
  const panorama = (engine: Engine) => { state(engine, true, 519, false); engine.drawElementsType(0, 6, 6); };
  const marker = (engine: Engine) => { state(engine, true, 515, false); engine.drawArraysType(0, 0, 4); };
  const groupClear = (engine: Engine, stencilValue = 0) => engine.clear(null, false, true, true, stencilValue);
  const frame = (engine: Engine, draw: () => void) => { engine.clear(color, true, true, true); draw(); engine.endFrame(); };
  /** The same calls with the clears held and not: what each draw sees, and the passes they took. */
  function play(calls: (engine: Engine) => void) {
    const [held, made] = [true, false].map(defer => {
      const { engine } = fixture(), canvas = engine as Engine;
      canvas.deferDepthClears = defer; calls(canvas);
      return canvas.canvas;
    });
    expect(held.draws).toEqual(made.draws);
    return { held, made };
  }

  it("draws a group that ignores depth, as a 360 image, in the pass already open", () => {
    const { held, made } = play(engine => {
      for (let i = 0; i < 2; i++) frame(engine, () => { terrain(engine); groupClear(engine); panorama(engine); });
    });
    expect(made.passes).toBe(4);
    expect(held.passes).toBe(2);
  });

  it("clears before a draw that tests depth or stencil, with the state that draw was set up with", () => {
    const { held, made } = play(engine => frame(engine, () => {
      terrain(engine); state(engine, true, 515, false); groupClear(engine, 3); engine.drawArraysType(0, 8, 4);
      panorama(engine); marker(engine);
      state(engine, false, 519, false); engine._stencilStateComposer.wanted = true; engine.drawArraysType(0, 4, 4);
    }));
    expect(made.draws).toContain("arrays 0 8 4: depth untested, scissor 0,0,0,0, stencil value 3");
    expect(made.draws).toContain("arrays 0 0 4: depth tested 515 on cleared, scissor 0,0,0,0, stencil value 3");
    expect(made.draws.at(-1)).toBe("arrays 0 4 4: depth untested, stencil on cleared to 3, scissor 0,0,0,0, stencil value 3");
    expect(held.passes).toBe(made.passes);
  });

  it("clears before a draw that only uses stencil, as its material settles it", () => {
    const { made } = play(engine => frame(engine, () => {
      terrain(engine); groupClear(engine, 4); panorama(engine);
      state(engine, false, 519, false); engine._stencilStateComposer.wanted = true; engine.drawElementsType(0, 12, 6);
    }));
    expect(made.draws.at(-1)).toBe("elements 0 12 6: depth untested, stencil on cleared to 4, scissor 0,0,0,0, stencil value 4");
  });

  it("draws over everything, as a marker, without the clear, and keeps its depth function", () => {
    const { held, made } = play(engine => {
      for (let i = 0; i < 2; i++) frame(engine, () => {
        terrain(engine); engine.clear(null, false, true, false); state(engine, true, 518, false); engine.drawArraysType(7, 0, 4);
        engine._depthCullingState.depthMask = true; engine.drawArraysType(7, 4, 4); engine.drawArraysType(7, 8, 4);
      });
    });
    expect(made.draws.at(-1)).toBe("arrays 7 8 4: depth tested 518 on cleared + arrays 7 4 4, written, scissor 0,0,0,0, stencil value 0");
    expect(held.passes).toBe(made.passes);
    const marker = play(engine => frame(engine, () => { terrain(engine); engine.clear(null, false, true, false); state(engine, true, 518, false); engine.drawArraysType(7, 0, 4); }));
    expect(marker.made.passes).toBe(2);
    expect(marker.held.passes).toBe(1);
  });

  it("tests depth on a held clear only in compatibility mode, and without one only for the stencil", () => {
    for (const compatible of [true, false]) {
      const { held, made } = play(engine => frame(engine, () => {
        (engine as unknown as { compatibilityMode: boolean }).compatibilityMode = compatible;
        terrain(engine); state(engine, true, 518, false); engine.drawArraysType(7, 0, 4);
        engine.clear(null, false, false, true, 1); engine.drawArraysType(7, 4, 4);
        engine.clear(null, false, true, false); engine.drawArraysType(7, 8, 4);
      }));
      expect(made.passes).toBe(3);
      expect(held.passes).toBe(compatible ? 1 : 2);
    }
  });

  it("clears the whole canvas under a scissor, and before a scissored clear", () => {
    play(engine => frame(engine, () => {
      terrain(engine); groupClear(engine); engine.enableScissor(1, 2, 3, 4); marker(engine);
      groupClear(engine, 5); marker(engine); engine.disableScissor();
      terrain(engine); groupClear(engine); engine.enableScissor(1, 2, 3, 4); engine.clear(null, false, true, false); engine.disableScissor(); marker(engine);
    }));
  });

  it("makes a clear held across a render target with the canvas's next pass", () => {
    const { held, made } = play(engine => frame(engine, () => {
      terrain(engine); groupClear(engine);
      const target = engine as unknown as { _currentRenderTarget: object | null; _currentRenderPass: object | null };
      target._currentRenderTarget = {}; target._currentRenderPass = null;
      engine.clear(color, true, true, true, 9); terrain(engine);
      target._currentRenderTarget = null; target._currentRenderPass = null;
      marker(engine); panorama(engine);
    }));
    // The pass Babylon starts for the marker sets its depth function to greater or equal.
    expect(made.draws).toContain("arrays 0 0 4: depth untested, scissor 0,0,0,0, stencil value 9");
    expect(made.passes).toBe(3);
    expect(held.passes).toBe(2);
  });

  it("makes a held clear with a later clear of the canvas", () => {
    const { held, made } = play(engine => frame(engine, () => {
      terrain(engine); groupClear(engine, 2); panorama(engine);
      const target = engine as unknown as { _currentRenderTarget: object | null };
      target._currentRenderTarget = {}; engine.clear(color, true, true, true, 6); target._currentRenderTarget = null;
      engine.clear(color, true, false, false); marker(engine);
    }));
    expect(made.draws.at(-1)).toBe("arrays 0 0 4: depth tested 515 on cleared, scissor 0,0,0,0, stencil value 6");
    expect(made.passes).toBe(3);
    expect(held.passes).toBe(2);
  });

  it("begins an occlusion query in the pass after the clear, and forgets the clear on resize", () => {
    const { held } = play(engine => {
      frame(engine, () => { terrain(engine); groupClear(engine); engine.beginOcclusionQuery(0, 0); marker(engine); });
      frame(engine, () => { terrain(engine); groupClear(engine, 7); });
      engine.setSize(2, 2);
      engine.clear(null, false, false, false); marker(engine); engine.endFrame();
    });
    expect(held.queries).toEqual([2]);
  });

  it("clears as Babylon does when off, into a render target or while snapshots record", () => {
    for (const setup of ["off", "target", "snapshot"]) {
      const { engine } = fixture(), canvas = engine as Engine;
      const internals = engine as unknown as { _currentRenderTarget: object | null; snapshotRendering: boolean };
      if (setup === "off") canvas.deferDepthClears = false;
      if (setup === "snapshot") internals.snapshotRendering = true;
      frame(canvas, () => {
        terrain(canvas);
        if (setup === "target") internals._currentRenderTarget = {};
        groupClear(canvas); panorama(canvas);
        internals._currentRenderTarget = null;
      });
      expect(canvas.canvas.passes).toBe(setup === "target" ? 1 : 2);
    }
  });

  it("makes a clear held when turned off at the next draw that needs it", () => {
    const { engine } = fixture(), canvas = engine as Engine;
    frame(canvas, () => { terrain(canvas); groupClear(canvas); canvas.deferDepthClears = false; panorama(canvas); marker(canvas); });
    expect(canvas.canvas.draws.at(-1)).toBe("arrays 0 0 4: depth tested 515 on cleared, scissor 0,0,0,0, stencil value 0");
    expect(canvas.canvas.passes).toBe(2);
  });
});
