import { describe, expect, it } from "vitest";
import { DynamicResolutionController } from "./dynamicResolution.js";

const overBudget = { gpuMs: 20, cpuMs: 4 };
const gpuBudgetAt60 = (1000 / 60) * 0.8;

describe("dynamic resolution controller", () => {
  it("starts on the ceiling and keeps every scale on a 0.05 step", () => {
    const controller = new DynamicResolutionController();
    expect(controller.scale).toBe(1);
    expect(controller.minScale).toBe(0.5);
    expect(controller.maxScale).toBe(1);
    expect(controller.targetFps).toBe(60);
    expect(controller.targetGpuMs).toBeCloseTo(gpuBudgetAt60);
    for (let frame = 0; frame < 3; frame += 1) controller.observe(overBudget);
    expect(controller.scale).toBe(0.75);
    expect(Math.round(controller.scale * 20)).toBeCloseTo(controller.scale * 20);
  });

  it("drops only after three over-budget GPU frames, to the step whose pixel cost fits", () => {
    const controller = new DynamicResolutionController();
    controller.observe(overBudget);
    controller.observe(overBudget);
    expect(controller.scale).toBe(1);
    controller.observe(overBudget);
    // 20 * 0.75^2 is inside 85% of the 60 Hz GPU budget; 0.80 is not.
    expect(controller.scale).toBe(0.75);
    expect(20 * (0.75 / 1) ** 2).toBeLessThanOrEqual(0.85 * gpuBudgetAt60);
    expect(20 * (0.8 / 1) ** 2).toBeGreaterThan(0.85 * gpuBudgetAt60);
  });

  it("waits out the cooldown before it can move again", () => {
    const controller = new DynamicResolutionController({ cooldownFrames: 2 });
    controller.observe(overBudget);
    controller.observe(overBudget);
    controller.observe(overBudget);
    expect(controller.scale).toBe(0.75);
    controller.observe(overBudget);
    controller.observe(overBudget);
    expect(controller.scale).toBe(0.75);
    controller.observe(overBudget);
    controller.observe(overBudget);
    controller.observe(overBudget);
    expect(controller.scale).toBeLessThan(0.75);
  });

  it("does not let an untimed frame or an ignored frame finish a drop", () => {
    const controller = new DynamicResolutionController();
    controller.observe(overBudget);
    controller.observe({ gpuMs: 0, cpuMs: 4 });
    controller.observe({ gpuMs: 20, cpuMs: 4, ignore: true });
    expect(controller.scale).toBe(1);
    controller.observe(overBudget);
    controller.observe(overBudget);
    expect(controller.scale).toBe(0.75);
  });

  it("rises one step after 45 frames whose predicted cost stays under 75% of the budget", () => {
    const controller = new DynamicResolutionController({ initialScale: 0.75 });
    const comfortable = { gpuMs: 8.5, cpuMs: 3 };
    const ratio = (0.8 / 0.75) ** 2;
    expect(8.5 * ratio).toBeLessThanOrEqual(0.75 * gpuBudgetAt60);
    for (let frame = 0; frame < 44; frame += 1) controller.observe(comfortable);
    expect(controller.scale).toBe(0.75);
    controller.observe(comfortable);
    expect(controller.scale).toBe(0.8);
  });

  it("refuses a step up that would land back over the headroom", () => {
    const controller = new DynamicResolutionController({ initialScale: 0.75 });
    const almost = { gpuMs: 9.5, cpuMs: 3 };
    expect(9.5).toBeLessThan(gpuBudgetAt60);
    expect(9.5 * (0.8 / 0.75) ** 2).toBeGreaterThan(0.75 * gpuBudgetAt60);
    for (let frame = 0; frame < 45; frame += 1) controller.observe(almost);
    expect(controller.scale).toBe(0.75);
  });

  it("does not shrink a CPU-bound frame whose GPU time is well under budget", () => {
    const controller = new DynamicResolutionController();
    for (let frame = 0; frame < 10; frame += 1) controller.observe({ gpuMs: 4, cpuMs: 40 });
    expect(controller.scale).toBe(1);
  });

  it("still shrinks when the GPU itself is over budget", () => {
    const controller = new DynamicResolutionController();
    controller.observe({ gpuMs: 20, cpuMs: 30 });
    controller.observe({ gpuMs: 20, cpuMs: 30 });
    controller.observe({ gpuMs: 20, cpuMs: 30 });
    expect(controller.scale).toBe(0.75);
  });

  it("clamps to a new ceiling and keeps an exact ceiling that is off the step grid", () => {
    const controller = new DynamicResolutionController();
    controller.setLimits(0.5, 0.72);
    expect(controller.scale).toBe(0.72);
    expect(controller.maxScale).toBe(0.72);
    expect(controller.minScale).toBe(0.5);
  });

  it("uses the frame-rate target as the GPU budget", () => {
    const controller = new DynamicResolutionController({ targetFps: 30 });
    expect(controller.targetGpuMs).toBeCloseTo((1000 / 30) * 0.8);
    controller.observe(overBudget);
    controller.observe(overBudget);
    controller.observe(overBudget);
    expect(controller.scale).toBe(1);
    controller.setTargetFps(60);
    controller.observe(overBudget);
    controller.observe(overBudget);
    controller.observe(overBudget);
    expect(controller.scale).toBe(0.75);
  });

  it("resets to the ceiling", () => {
    const controller = new DynamicResolutionController({ initialScale: 0.6 });
    controller.reset();
    expect(controller.scale).toBe(1);
  });
});
