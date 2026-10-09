import { NullEngine, Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createPerformanceMetrics } from "./metrics.js";

describe("host-supplied performance observations", () => {
  it("retains the bounded interval window and reads host memory exactly once per observation", () => {
    const engine = new NullEngine(), scene = new Scene(engine);
    let now = 0;
    const clock = vi.fn(() => now), memoryBytes = vi.fn(() => 2 * 1_048_576);
    try {
      const metrics = createPerformanceMetrics({ engine, scene, now: clock, memoryBytes, frameSampleCount: 3,
        getTileMetrics: () => ({ visibleTiles: 2, activeTiles: 4 }), getCullingStats: () => ({ total: 3, visible: 1, hidden: 2 }) });
      expect(clock).toHaveBeenCalledOnce(); expect(memoryBytes).not.toHaveBeenCalled();
      for (const delta of [100, 10, 20, 30]) { now += delta; metrics.update(); }
      expect(metrics.getSnapshot()).toMatchObject({ frameMs: 30, p95FrameMs: 20, memoryMb: 2, tiles: { visibleTiles: 2, activeTiles: 4 } });
      expect(clock).toHaveBeenCalledTimes(5); expect(memoryBytes).toHaveBeenCalledTimes(4);
      expect(metrics.format()).toContain("t2/4 c1/3 m2MB");
      expect(clock).toHaveBeenCalledTimes(5); expect(memoryBytes).toHaveBeenCalledTimes(4);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it("reports absent host memory and refuses invalid retention before reading host observations", () => {
    const engine = new NullEngine(), scene = new Scene(engine), now = vi.fn(() => 5);
    try {
      const options = { engine, scene, now, memoryBytes: () => null, getTileMetrics: () => null, getCullingStats: () => ({ total: 0, visible: 0, hidden: 0 }) };
      for (const frameSampleCount of [0, -1, 1.5, Infinity]) expect(() => createPerformanceMetrics({ ...options, frameSampleCount })).toThrow(RangeError);
      expect(now).not.toHaveBeenCalled();
      const metrics = createPerformanceMetrics(options); metrics.update();
      expect(metrics.getSnapshot().memoryMb).toBeNull(); expect(metrics.format()).not.toContain("MB");
    } finally { scene.dispose(); engine.dispose(); }
  });
});
