import { describe, expect, it } from "vitest";
import { resolveSpatialUpscalingState, rcasSharpnessToAttenuation, SPATIAL_UPSCALING_WEBGL1_NOTE } from "./spatialUpscaling.js";

describe("spatial upscaling state", () => {
  it("maps sharpness through stops to a power-of-two attenuation", () => {
    expect(rcasSharpnessToAttenuation(0)).toBeCloseTo(2 ** -2);
    expect(rcasSharpnessToAttenuation(0.2)).toBeCloseTo(2 ** -(2 * 0.8));
    expect(rcasSharpnessToAttenuation(0.5)).toBeCloseTo(0.5);
    expect(rcasSharpnessToAttenuation(1)).toBeCloseTo(1);
    expect(rcasSharpnessToAttenuation(-2)).toBeCloseTo(0.25);
    expect(rcasSharpnessToAttenuation(4)).toBeCloseTo(1);
    expect(rcasSharpnessToAttenuation(Number.NaN)).toBeCloseTo(0.25);
  });

  it("stays off unless a supported mode is drawing below native", () => {
    expect(resolveSpatialUpscalingState({ mode: "off", sharpness: 0.2, effectiveRenderScale: 0.5 })).toMatchObject({ active: false, easu: false, rcas: false, unavailableReason: null });
    expect(resolveSpatialUpscalingState({ mode: "easu", sharpness: 0.2, effectiveRenderScale: 1 })).toMatchObject({ active: false, easu: false, rcas: false });
    expect(resolveSpatialUpscalingState({ mode: "easu", sharpness: 0.2, effectiveRenderScale: 0.999 })).toMatchObject({ active: false });
    expect(resolveSpatialUpscalingState({ mode: "easu", sharpness: 0.2, effectiveRenderScale: 0.998, backend: "webgpu" })).toMatchObject({ active: true, easu: true, rcas: false, unavailableReason: null });
    expect(resolveSpatialUpscalingState({ mode: "easu-rcas", sharpness: 0.2, effectiveRenderScale: 0.5, backend: "webgl2" })).toMatchObject({
      active: true, easu: true, rcas: true, attenuation: rcasSharpnessToAttenuation(0.2),
    });
  });

  it("explains the WebGL1 bypass and ignores an unknown mode", () => {
    expect(resolveSpatialUpscalingState({ mode: "easu", sharpness: 1, effectiveRenderScale: 0.5, backend: "webgl" })).toEqual({
      active: false, easu: false, rcas: false, attenuation: 1, unavailableReason: SPATIAL_UPSCALING_WEBGL1_NOTE,
    });
    expect(resolveSpatialUpscalingState({ mode: "off", sharpness: 0.2, effectiveRenderScale: 0.5, backend: "webgl" }).unavailableReason).toBeNull();
    expect(resolveSpatialUpscalingState({ mode: "spatial", sharpness: 0.2, effectiveRenderScale: 0.5 }).active).toBe(false);
  });
});
