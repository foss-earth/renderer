import { createSettingsRegistry, URL_PARAMETER_PREFIX, type DeviceContext } from "@foss-earth/ui/settings";
import { describe, expect, it } from "vitest";
import { RENDERER_PARAMETERS } from "./catalogue.js";

const DEVICE: DeviceContext = {
  rendererMode: null, maxTextureSize: null, devicePixelRatio: 1, hardwareConcurrency: null,
  deviceMemoryGiB: null, touch: false, frameTimeMs: null, refreshIntervalMs: null, rendererDevicePixels: null,
};

const ADDED = ["renderer.upscaling", "renderer.upscalingSharpness", "renderer.dynamicResolution", "renderer.targetFps"] as const;

describe("renderer settings catalogue", () => {
  it("adds upscaling and dynamic resolution to the six original renderer parameters", () => {
    expect(RENDERER_PARAMETERS).toHaveLength(10);
    expect(RENDERER_PARAMETERS.map(spec => spec.id)).toEqual([
      "renderer.backend",
      "renderer.resolutionScale",
      "renderer.antialias",
      "renderer.frameRateCap",
      ...ADDED,
      "renderer.clipping",
      "renderer.clipping.fixed",
    ]);
  });

  it("defaults upscaling off, sharpness to 0.2, dynamic resolution off, and the target to 60", () => {
    const settings = createSettingsRegistry();
    settings.register(RENDERER_PARAMETERS);
    expect(settings.get("renderer.upscaling")).toBe("off");
    expect(settings.get("renderer.upscalingSharpness")).toBe(0.2);
    expect(settings.get("renderer.dynamicResolution")).toBe(false);
    expect(settings.get("renderer.targetFps")).toBe(60);
    const sharpness = RENDERER_PARAMETERS.find(spec => spec.id === "renderer.upscalingSharpness");
    const target = RENDERER_PARAMETERS.find(spec => spec.id === "renderer.targetFps");
    expect(sharpness?.kind === "number" && sharpness.bounds ? [sharpness.step, sharpness.bounds(DEVICE).min, sharpness.bounds(DEVICE).max] : []).toEqual([0.05, 0, 1]);
    expect(target?.kind === "number" && target.bounds ? [target.step, target.bounds(DEVICE).min, target.bounds(DEVICE).max] : []).toEqual([5, 30, 120]);
  });

  it("rejects values outside the catalogue", () => {
    const settings = createSettingsRegistry();
    settings.register(RENDERER_PARAMETERS);
    expect(settings.set("renderer.upscaling", "spatial").ok).toBe(false);
    expect(settings.set("renderer.upscalingSharpness", 1.2).ok).toBe(false);
    expect(settings.set("renderer.upscalingSharpness", -0.05).ok).toBe(false);
    expect(settings.set("renderer.dynamicResolution", "yes").ok).toBe(false);
    expect(settings.set("renderer.targetFps", 20).ok).toBe(false);
    expect(settings.set("renderer.targetFps", 125).ok).toBe(false);
    expect(settings.get("renderer.upscaling")).toBe("off");
    expect(settings.get("renderer.targetFps")).toBe(60);
  });

  it("reads the four settings from set. URL parameters and round-trips them through JSON", () => {
    const fromUrl = createSettingsRegistry({
      searchParams: new URLSearchParams([
        [`${URL_PARAMETER_PREFIX}renderer.upscaling`, "easu-rcas"],
        [`${URL_PARAMETER_PREFIX}renderer.upscalingSharpness`, "0.4"],
        [`${URL_PARAMETER_PREFIX}renderer.dynamicResolution`, "true"],
        [`${URL_PARAMETER_PREFIX}renderer.targetFps`, "90"],
      ]),
    });
    fromUrl.register(RENDERER_PARAMETERS);
    expect(fromUrl.get("renderer.upscaling")).toBe("easu-rcas");
    expect(fromUrl.get("renderer.upscalingSharpness")).toBe(0.4);
    expect(fromUrl.get("renderer.dynamicResolution")).toBe(true);
    expect(fromUrl.get("renderer.targetFps")).toBe(90);

    const saved = createSettingsRegistry();
    saved.register(RENDERER_PARAMETERS);
    expect(saved.set("renderer.upscaling", "easu").ok).toBe(true);
    expect(saved.set("renderer.upscalingSharpness", 0.6).ok).toBe(true);
    expect(saved.set("renderer.dynamicResolution", true).ok).toBe(true);
    expect(saved.set("renderer.targetFps", 45).ok).toBe(true);
    const exported = saved.export();
    expect(exported).toMatchObject({ format: "foss-earth.settings", version: 1 });
    const loaded = createSettingsRegistry();
    loaded.register(RENDERER_PARAMETERS);
    expect(loaded.import(JSON.parse(JSON.stringify(exported))).rejected).toEqual([]);
    expect(loaded.get("renderer.upscaling")).toBe("easu");
    expect(loaded.get("renderer.upscalingSharpness")).toBe(0.6);
    expect(loaded.get("renderer.dynamicResolution")).toBe(true);
    expect(loaded.get("renderer.targetFps")).toBe(45);
  });
});
