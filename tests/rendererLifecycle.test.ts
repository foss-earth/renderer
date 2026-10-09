import { NullEngine, Scene } from "@babylonjs/core";
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
    const release = vi.fn();
    resources.adopt(old, { value: {}, dispose: release });
    const endHostLease = vi.fn();
    const lifecycle = createBabylonRendererLifecycle({ ...f, renderer: { engine: f.engine, requested: "auto", mode: "webgl2" }, presentationLayer: 0x10000000, isPreparingFrame: () => false, resources, onDeviceLost: endHostLease });
    const lost = vi.fn();
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
});
