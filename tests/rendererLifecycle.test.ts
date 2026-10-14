import { Mesh, NullEngine, Scene } from "@babylonjs/core";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { describe, expect, it, vi } from "vitest";
import { createBabylonRendererLifecycle } from "../src/babylon/rendererLifecycle.js";
import { createRendererResourceLifecycle } from "../src/resourceLifecycle.js";
import { RENDERER_PARAMETERS, RENDERER_OWNED_EXPERIMENT_PARAMETERS } from "../src/settings/catalogue.js";
import type { RenderScheduler } from "../src/renderScheduler.js";

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const settings = createSettingsRegistry();
  settings.register([...RENDERER_PARAMETERS, ...RENDERER_OWNED_EXPERIMENT_PARAMETERS]);
  const requestRender = vi.fn();
  let activeChanged: (active: boolean) => void = () => undefined;
  const unsubscribe = vi.fn();
  const scheduler: RenderScheduler = { requestRender, beginContinuous: vi.fn(), endContinuous: vi.fn(), isContinuous: () => false, setPaused: vi.fn(), stop: vi.fn(), isActive: () => false, onActiveChange(listener) { activeChanged = listener; return unsubscribe; } };
  let resize: () => void = () => undefined;
  let visibility: () => void = () => undefined;
  const removeResize = vi.fn();
  const removeVisibility = vi.fn();
  const platform = { devicePixelRatio: () => 2, isHidden: () => true, onResize(listener: () => void) { resize = listener; return removeResize; }, onVisibilityChange(listener: () => void) { visibility = listener; return removeVisibility; } };
  return { engine, scene, settings, scheduler, requestRender, platform, unsubscribe, removeResize, removeVisibility, resize: () => resize(), visibility: () => visibility(), activeChanged: (active: boolean) => activeChanged(active) };
}

describe("renderer-only runtime lifecycle", () => {
  it("rolls back prior watches and scene observers when a later settings watch fails", () => {
    const f = fixture();
    f.settings.set("renderer.experiments.presentationCandidates", true);
    const originalCandidates = f.scene.getActiveMeshCandidates;
    const acquired: Array<ReturnType<typeof vi.fn>> = [];
    const stale: Array<() => void> = [];
    vi.spyOn(f.settings, "watch").mockImplementation((id, listener) => {
      if (acquired.length === 2) throw new Error("watch refused");
      stale.push(() => listener(f.settings.get(id) as never));
      const stop = vi.fn(); acquired.push(stop); return stop;
    });
    const sceneDispose = vi.spyOn(f.scene, "dispose");
    const engineDispose = vi.spyOn(f.engine, "dispose");
    try {
      expect(() => createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false })).toThrow("watch refused");
      expect(acquired).toHaveLength(2);
      for (const stop of acquired) expect(stop).toHaveBeenCalledOnce();
      expect(f.unsubscribe).toHaveBeenCalledOnce();
      expect(f.scene.getActiveMeshCandidates).toBe(originalCandidates);
      for (const observable of [f.scene.onNewMeshAddedObservable, f.scene.onMeshRemovedObservable, f.scene.onNewLightAddedObservable, f.scene.onLightRemovedObservable]) expect(observable.hasObservers()).toBe(false);
      f.requestRender.mockClear(); for (const callback of stale) callback(); f.activeChanged(false);
      expect(f.requestRender).not.toHaveBeenCalled();
      expect(f.scheduler.stop).not.toHaveBeenCalled();
      expect(sceneDispose).not.toHaveBeenCalled(); expect(engineDispose).not.toHaveBeenCalled();
    } finally { f.scene.dispose(); f.engine.dispose(); }
  });

  it("releases resize and prior resources when visibility subscription throws, even if one stop throws", () => {
    const f = fixture();
    const originalCandidates = f.scene.getActiveMeshCandidates;
    f.settings.set("renderer.experiments.presentationCandidates", true);
    const failure = new Error("visibility refused");
    f.platform.onVisibilityChange = () => { throw failure; };
    f.unsubscribe.mockImplementation(() => { throw new Error("unsubscribe failed"); });
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(f.settings, "watch").mockImplementation(() => { const stop = vi.fn(); stops.push(stop); return stop; });
    try {
      expect(() => createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false })).toThrow("startup and cleanup failed");
      for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
      expect(f.removeResize).toHaveBeenCalledOnce();
      expect(f.scene.getActiveMeshCandidates).toBe(originalCandidates);
      expect(f.scene.onNewMeshAddedObservable.hasObservers()).toBe(false);
      expect(f.scene.onLightRemovedObservable.hasObservers()).toBe(false);
      f.requestRender.mockClear(); f.resize();
      expect(f.requestRender).not.toHaveBeenCalled();
      expect(f.scheduler.stop).not.toHaveBeenCalled();
    } finally { f.scene.dispose(); f.engine.dispose(); }
  });

  it("rolls back a context-loss observer if the restored subscription fails", () => {
    const f = fixture();
    const before = f.engine.onContextLostObservable.hasObservers();
    vi.spyOn(f.engine.onContextRestoredObservable, "add").mockImplementation(() => { throw new Error("restore refused"); });
    try {
      expect(() => createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false })).toThrow("restore refused");
      expect(f.engine.onContextLostObservable.hasObservers()).toBe(before);
      expect(f.removeResize).toHaveBeenCalledOnce(); expect(f.removeVisibility).toHaveBeenCalledOnce();
    } finally { f.scene.dispose(); f.engine.dispose(); }
  });

  it("rolls back partial scene-update registration and attempts every owned stop exactly once", () => {
    const f = fixture();
    vi.spyOn(f.scene.onNewLightAddedObservable, "add").mockImplementation(() => { throw new Error("light watch refused"); });
    const removedMesh = vi.spyOn(f.scene.onMeshRemovedObservable, "remove");
    const originalRemove = f.scene.onNewMeshAddedObservable.remove.bind(f.scene.onNewMeshAddedObservable);
    vi.spyOn(f.scene.onNewMeshAddedObservable, "remove").mockImplementation(observer => { originalRemove(observer); throw new Error("mesh stop failed"); });
    try {
      expect(() => createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false })).toThrow("Scene update startup and cleanup failed");
      expect(removedMesh).toHaveBeenCalledOnce();
      expect(f.scene.onMeshRemovedObservable.hasObservers()).toBe(false);
      expect(f.scene.onNewMeshAddedObservable.hasObservers()).toBe(false);
      expect(f.scheduler.stop).not.toHaveBeenCalled();
    } finally { f.scene.dispose(); f.engine.dispose(); }
  });

  it("attempts every teardown after a failing stop and makes stale host callbacks inert", () => {
    const f = fixture();
    f.settings.set("renderer.experiments.presentationCandidates", true);
    const originalCandidates = f.scene.getActiveMeshCandidates;
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
    f.unsubscribe.mockImplementation(() => { throw new Error("stop failed"); });
    try {
      expect(() => lifecycle.dispose()).toThrow("Renderer lifecycle cleanup failed");
      lifecycle.dispose();
      expect(f.unsubscribe).toHaveBeenCalledOnce(); expect(f.removeResize).toHaveBeenCalledOnce(); expect(f.removeVisibility).toHaveBeenCalledOnce();
      expect(f.scene.getActiveMeshCandidates).toBe(originalCandidates);
      expect(f.scene.onLightRemovedObservable.hasObservers()).toBe(false);
      f.requestRender.mockClear(); f.resize(); f.visibility(); f.activeChanged(false);
      f.settings.set("renderer.resolutionScale", 0.5);
      expect(f.requestRender).not.toHaveBeenCalled();
      expect(f.scheduler.setPaused).not.toHaveBeenCalled(); expect(f.scheduler.stop).not.toHaveBeenCalled();
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
  });

  it("preserves resolution/DPR and forwards camera-owned clipping without importing it", () => {
    const f = fixture();
    const scaling = vi.spyOn(f.engine, "setHardwareScalingLevel");
    const clipping = vi.fn();
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2", devicePixels: true }, presentationLayer: 0x10000000, isPreparingFrame: () => false, applyClipping: clipping });
    try {
      f.settings.set("renderer.resolutionScale", 0.5);
      expect(scaling).toHaveBeenLastCalledWith(1);
      f.resize();
      expect(scaling).toHaveBeenLastCalledWith(1);
      f.settings.set("renderer.clipping.fixed", { min: 5, max: 2e6 });
      f.settings.set("renderer.clipping", "fixed");
      expect(clipping).toHaveBeenCalledTimes(2);
      f.visibility();
      expect(f.scheduler.setPaused).toHaveBeenCalledWith(true);
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.removeResize).toHaveBeenCalledOnce();
    expect(f.removeVisibility).toHaveBeenCalledOnce();
    expect(f.scheduler.stop).not.toHaveBeenCalled();
  });

  it("increments device generation, retires resources and asks on restoration through the same scheduler", () => {
    const f = fixture();
    const resources = createRendererResourceLifecycle({ identity: { rendererId: "main", backendId: "webgl2", deviceId: "device" }, requestRender: f.requestRender });
    const old = resources.currentGeneration();
    const cleanupOrder: string[] = [];
    const release = vi.fn(() => { cleanupOrder.push("resource"); });
    resources.adopt(old, { value: {}, dispose: release });
    const endHostLease = vi.fn(() => { cleanupOrder.push("lease"); });
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false, resources, onDeviceLost: endHostLease });
    const lost = vi.fn(() => { cleanupOrder.push("subscriber"); });
    const restored = vi.fn();
    lifecycle.onDeviceLost(lost);
    lifecycle.onDeviceRestored(restored);
    try {
      f.engine.onContextLostObservable.notifyObservers(f.engine);
      expect(lifecycle.getDeviceGeneration()).toBe(1);
      expect(resources.isCurrent(old)).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      expect(endHostLease).toHaveBeenCalledOnce();
      expect(lost).toHaveBeenCalledOnce();
      expect(cleanupOrder).toEqual(["lease", "resource", "subscriber"]);
      f.requestRender.mockClear();
      f.engine.onContextRestoredObservable.notifyObservers(f.engine);
      expect(restored).toHaveBeenCalledOnce();
      expect(f.requestRender).toHaveBeenCalledOnce();
      lifecycle.dispose();
      lifecycle.dispose();
      f.engine.onContextLostObservable.notifyObservers(f.engine);
      expect(lost).toHaveBeenCalledOnce();
    } finally { lifecycle.dispose(); resources.dispose(); f.scene.dispose(); f.engine.dispose(); }
  });

  it("brackets rendering with begin/endFrame and leaves the supplied scene/device ownership to the host", () => {
    const f = fixture();
    const calls: string[] = [];
    vi.spyOn(f.engine, "beginFrame").mockImplementation(() => { calls.push("begin"); });
    vi.spyOn(f.engine, "endFrame").mockImplementation(() => { calls.push("end"); });
    vi.spyOn(f.scene, "render").mockImplementation(() => { calls.push("render"); });
    const engineDispose = vi.spyOn(f.engine, "dispose");
    const sceneDispose = vi.spyOn(f.scene, "dispose");
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
    try {
      lifecycle.renderFrame(() => { calls.push("prepare"); }, () => { calls.push("after"); });
      expect(calls).toEqual(["begin", "prepare", "render", "end", "after"]);
      lifecycle.dispose();
      expect(sceneDispose).not.toHaveBeenCalled();
      expect(engineDispose).not.toHaveBeenCalled();
      lifecycle.renderFrame();
      expect(calls).toHaveLength(5);
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
  });
  it("suppresses presentation while the device is lost and resumes through the existing restored event", () => {
    const f = fixture();
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgpu" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
    const begin = vi.spyOn(f.engine, "beginFrame").mockImplementation(() => {}), end = vi.spyOn(f.engine, "endFrame").mockImplementation(() => {});
    const render = vi.spyOn(f.scene, "render").mockImplementation(() => {}), prepare = vi.fn();
    try {
      f.engine.onContextLostObservable.notifyObservers(f.engine);
      lifecycle.renderFrame(prepare);
      expect(begin).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
      f.engine.onContextRestoredObservable.notifyObservers(f.engine);
      lifecycle.renderFrame(prepare);
      expect(begin).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledOnce(); expect(render).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
  });
  it("cancels pending shader readiness checks on loss and does not start them while idle on a lost device", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = fixture(); f.platform.isHidden = () => false;
    const pending = new Mesh("pending shader", f.scene), ready = vi.spyOn(pending, "isReady").mockReturnValue(false);
    vi.spyOn(f.scene, "getActiveMeshes").mockReturnValue({ length: 1, data: [pending] } as never);
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgpu" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
    try {
      f.activeChanged(false);
      expect(ready).toHaveBeenCalledOnce();
      f.engine.onContextLostObservable.notifyObservers(f.engine);
      f.activeChanged(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ready).toHaveBeenCalledOnce();
      f.engine.onContextRestoredObservable.notifyObservers(f.engine);
      f.activeChanged(false);
      expect(ready).toHaveBeenCalledTimes(2);
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); await vi.advanceTimersByTimeAsync(2); vi.useRealTimers(); }
  });
  it("attempts restore peers and one frame request despite failures, retaining ordered errors", () => {
    const f = fixture();
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
    const calls: string[] = [], firstError = new Error("First restore failed"), secondError = new Error("Second restore failed"), requestError = new Error("Restore frame refused");
    const first = vi.fn(() => { calls.push("first"); throw firstError; });
    const second = vi.fn(() => { calls.push("second"); throw secondError; });
    lifecycle.onDeviceRestored(first); lifecycle.onDeviceRestored(second);
    f.requestRender.mockClear(); f.requestRender.mockImplementation(() => { calls.push("request"); throw requestError; });
    try {
      let failure: unknown;
      try { f.engine.onContextRestoredObservable.notifyObservers(f.engine); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([firstError, secondError, requestError]);
      expect(calls).toEqual(["first", "second", "request"]);
      expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce(); expect(f.requestRender).toHaveBeenCalledOnce();
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
  });
  it("skips a restore listener removed by an earlier callback while retaining remaining peers", () => {
    const f = fixture();
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
    let removeLater = () => {};
    const removed = vi.fn(), remaining = vi.fn();
    lifecycle.onDeviceRestored(() => { removeLater(); });
    removeLater = lifecycle.onDeviceRestored(removed); lifecycle.onDeviceRestored(remaining);
    f.requestRender.mockClear();
    try {
      f.engine.onContextRestoredObservable.notifyObservers(f.engine);
      expect(removed).not.toHaveBeenCalled(); expect(remaining).toHaveBeenCalledOnce(); expect(f.requestRender).toHaveBeenCalledOnce();
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
  });
  it("suppresses restore callbacks and its pending frame request after a subscriber ends the binding", () => {
    const f = fixture();
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
    const later = vi.fn(); lifecycle.onDeviceRestored(() => { lifecycle.dispose(); }); lifecycle.onDeviceRestored(later);
    f.requestRender.mockClear();
    try {
      f.engine.onContextRestoredObservable.notifyObservers(f.engine);
      expect(later).not.toHaveBeenCalled(); expect(f.requestRender).not.toHaveBeenCalled();
      lifecycle.onDeviceRestored(later); f.engine.onContextRestoredObservable.notifyObservers(f.engine);
      expect(later).not.toHaveBeenCalled(); expect(f.requestRender).not.toHaveBeenCalled();
      expect(f.scheduler.stop).not.toHaveBeenCalled();
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
  });
  it("does not end a frame that beginFrame failed to begin, or call feature preparation/after", () => {
    const f = fixture();
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
    const failure = new Error("Begin refused"), prepare = vi.fn(), after = vi.fn();
    const begin = vi.spyOn(f.engine, "beginFrame").mockImplementation(() => { throw failure; });
    const end = vi.spyOn(f.engine, "endFrame").mockImplementation(() => {});
    const render = vi.spyOn(f.scene, "render").mockImplementation(() => {});
    try {
      let error: unknown; try { lifecycle.renderFrame(prepare, after); } catch (caught) { error = caught; }
      expect(error).toBe(failure); expect(begin).toHaveBeenCalledOnce(); expect(end).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled(); expect(render).not.toHaveBeenCalled(); expect(after).not.toHaveBeenCalled();
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
  });
  for (const phase of ["prepare", "render"] as const) {
    it(`retains ${phase} and endFrame failures in order and ends the begun frame only once`, () => {
      const f = fixture();
      const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
      const calls: string[] = [], primary = new Error(`${phase} failed`), completion = new Error("End failed"), after = vi.fn();
      const begin = vi.spyOn(f.engine, "beginFrame").mockImplementation(() => { calls.push("begin"); });
      const end = vi.spyOn(f.engine, "endFrame").mockImplementation(() => { calls.push("end"); throw completion; });
      const render = vi.spyOn(f.scene, "render").mockImplementation(() => { calls.push("render"); if (phase === "render") throw primary; });
      try {
        let failure: unknown;
        try { lifecycle.renderFrame(() => { calls.push("prepare"); if (phase === "prepare") throw primary; }, after); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(AggregateError); expect((failure as AggregateError).errors).toEqual([primary, completion]);
        expect(begin).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledOnce(); expect(after).not.toHaveBeenCalled();
        expect(calls).toEqual(phase === "prepare" ? ["begin", "prepare", "end"] : ["begin", "prepare", "render", "end"]);
        expect(render).toHaveBeenCalledTimes(phase === "render" ? 1 : 0);
      } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
    });
  }
  it("preserves a single endFrame failure and skips afterRender despite successful preparation/render", () => {
    const f = fixture();
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false });
    const failure = new Error("Only end failed"), prepare = vi.fn(), after = vi.fn();
    const begin = vi.spyOn(f.engine, "beginFrame").mockImplementation(() => {});
    const end = vi.spyOn(f.engine, "endFrame").mockImplementation(() => { throw failure; });
    const render = vi.spyOn(f.scene, "render").mockImplementation(() => {});
    try {
      let error: unknown; try { lifecycle.renderFrame(prepare, after); } catch (caught) { error = caught; }
      expect(error).toBe(failure); expect(begin).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
      expect(render).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledOnce(); expect(after).not.toHaveBeenCalled();
    } finally { lifecycle.dispose(); f.scene.dispose(); f.engine.dispose(); }
  });
});
