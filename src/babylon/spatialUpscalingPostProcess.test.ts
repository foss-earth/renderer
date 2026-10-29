import { Effect, FreeCamera, NullEngine, Scene, Vector3, type Camera } from "@babylonjs/core";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore.js";
import { describe, expect, it, vi } from "vitest";
import { EASU_FRAGMENT_GLSL, EASU_FRAGMENT_WGSL, RCAS_FRAGMENT_GLSL, RCAS_FRAGMENT_WGSL, createSpatialUpscalingPasses } from "./spatialUpscalingPostProcess.js";

function live(camera: Camera): number {
  return (camera as Camera & { _postProcesses: unknown[] })._postProcesses.filter(Boolean).length;
}

describe("spatial upscaling passes", () => {
  it("registers the 12-tap EASU and lobe-clamped RCAS shaders in GLSL and WGSL", () => {
    expect(Effect.ShadersStore.easuPixelShader).toBe(EASU_FRAGMENT_GLSL);
    expect(Effect.ShadersStore.rcasPixelShader).toBe(RCAS_FRAGMENT_GLSL);
    expect(ShaderStore.ShadersStoreWGSL.easuPixelShader).toBe(EASU_FRAGMENT_WGSL);
    expect(ShaderStore.ShadersStoreWGSL.rcasPixelShader).toBe(RCAS_FRAGMENT_WGSL);
    expect(EASU_FRAGMENT_GLSL).toContain("vec3(0.25, 0.5, 0.25)");
    expect(EASU_FRAGMENT_GLSL.match(/sampleTap\(base/g)?.length).toBe(12);
    expect(RCAS_FRAGMENT_GLSL).toContain("0.1875");
    expect(RCAS_FRAGMENT_WGSL).toContain("0.1875");
    expect(EASU_FRAGMENT_WGSL).toContain("vec3f(0.25, 0.5, 0.25)");
  });

  it("attaches to the active camera, follows a camera change, and detaches", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const first = new FreeCamera("first", Vector3.Zero(), scene);
    const second = new FreeCamera("second", Vector3.Zero(), scene);
    scene.activeCamera = first;
    const scaling = vi.spyOn(engine, "setHardwareScalingLevel");
    const passes = createSpatialUpscalingPasses(scene, engine);
    try {
      passes.sync({ easu: true, rcas: true, attenuation: 0.5, renderScale: 0.5 });
      expect(passes.isAttached()).toBe(true);
      expect(live(first)).toBe(2);
      scene.activeCamera = second;
      expect(live(first)).toBe(0);
      expect(live(second)).toBe(2);
      expect(passes.isAttached()).toBe(true);
      engine.onResizeObservable.notifyObservers(engine);
      expect(scaling).not.toHaveBeenCalled();
      passes.sync({ easu: false, rcas: false, attenuation: 0.5, renderScale: 1 });
      expect(passes.isAttached()).toBe(false);
      expect(live(second)).toBe(0);
      scene.activeCamera = null;
      passes.sync({ easu: true, rcas: false, attenuation: 1, renderScale: 0.5 });
      expect(passes.isAttached()).toBe(false);
    } finally {
      passes.dispose();
      passes.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
});
