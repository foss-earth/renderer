import { Observable, type AbstractEngine, type Scene } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { createFrameProfiler } from "../src/profiling/frameProfiler.js";
import { profileBabylonScene } from "../src/babylon/frameProfiler.js";

/** A profiler on a hand-driven clock. */
function manual(windowFrames = 10) {
  let time = 0;
  const profiler = createFrameProfiler({ windowFrames, enabled: true, now: () => time });
  return {
    profiler,
    at: (ms: number) => { time = ms; },
    /** Runs `ms` of work in the section, starting now. */
    work: (section: string, ms: number) => { const started = profiler.clock(); time += ms; profiler.add(section, started); },
  };
}

describe("frame profiler", () => {
  it("records Babylon CPU work starting at clock zero and detaches its measurements", () => {
    const observable = () => new Observable<Scene>();
    const scene = {
      onBeforeAnimationsObservable: observable(), onAfterRenderObservable: observable(),
      onBeforeActiveMeshesEvaluationObservable: observable(), onAfterActiveMeshesEvaluationObservable: observable(),
      onBeforeRenderTargetsRenderObservable: observable(), onAfterRenderTargetsRenderObservable: observable(),
      onBeforeDrawPhaseObservable: observable(), onAfterDrawPhaseObservable: observable(),
    } as unknown as Scene;
    const t = manual();
    const stop = profileBabylonScene(t.profiler, scene, { getCaps: () => ({}) } as unknown as AbstractEngine);
    t.profiler.frame(0); scene.onBeforeAnimationsObservable.notifyObservers(scene); t.at(4); scene.onAfterRenderObservable.notifyObservers(scene); t.profiler.frame(16);
    expect(t.profiler.summary().sections.find(section => section.section === "render")?.meanMs).toBe(4);
    stop(); stop(); expect(scene.onBeforeAnimationsObservable.hasObservers()).toBe(false);
  });
  it("adds each section up per frame and holds it against the frame interval", () => {
    const t = manual();
    for (let frame = 0; frame <= 4; frame++) {
      t.at(frame * 16);
      t.profiler.frame();
      t.work("flight", 3);
      t.work("render", 5);
    }
    const summary = t.profiler.summary();
    expect(summary.frames).toBe(4);
    expect(summary.frame.meanMs).toBe(16);
    expect(summary.measuredMeanMs).toBe(8);
    const render = summary.sections.find(section => section.section === "render")!;
    expect(render.meanMs).toBe(5);
    expect(render.shareOfFrame).toBeCloseTo(5 / 16);
  });

  it("nests sections by path, counting only the top level against the frame", () => {
    const t = manual();
    for (let frame = 0; frame <= 2; frame++) {
      t.at(frame * 20);
      t.profiler.frame();
      const started = t.profiler.clock();
      t.work("flight/physics", 4);
      t.work("flight/hud", 1);
      t.profiler.add("flight", started);
    }
    const summary = t.profiler.summary();
    expect(summary.measuredMeanMs).toBe(5);
    expect(summary.sections.map(section => [section.section, section.depth])).toEqual([
      ["flight", 0], ["flight/physics", 1], ["flight/hud", 1],
    ]);
  });

  it("averages a section that runs on some frames only over every frame", () => {
    const t = manual();
    for (let frame = 0; frame <= 4; frame++) {
      t.at(frame * 10);
      t.profiler.frame();
      if (frame % 2 === 0) t.work("panels", 4);
    }
    const panels = t.profiler.summary().sections.find(section => section.section === "panels")!;
    expect(panels.meanMs).toBe(2);
    expect(panels.activeFrames).toBe(2);
  });

  it("keeps only the window", () => {
    const t = manual(3);
    for (let frame = 0; frame <= 6; frame++) {
      t.at(frame * 10);
      t.profiler.frame();
      t.work("tick", frame);
    }
    const tick = t.profiler.summary().sections[0];
    expect(t.profiler.summary().frames).toBe(3);
    expect(tick.maxMs).toBe(5);
    expect(tick.meanMs).toBe(4);
  });

  it("takes durations measured elsewhere, such as GPU timers", () => {
    const t = manual();
    t.at(0);
    t.profiler.frame();
    t.profiler.addDuration("gpu/globe", 2.5);
    t.at(16);
    t.profiler.frame();
    expect(t.profiler.summary().sections.map(section => [section.section, section.meanMs])).toEqual([
      ["gpu", 2.5], ["gpu/globe", 2.5],
    ]);
  });

  it("never adds GPU time to the frame, which it runs alongside", () => {
    const t = manual();
    t.at(0);
    t.profiler.frame();
    t.work("render", 4);
    t.profiler.addDuration("gpu/globe", 6);
    t.at(16);
    t.profiler.frame();
    expect(t.profiler.summary().measuredMeanMs).toBe(4);
  });

  it("does nothing while disabled, and starts a fresh window when enabled", () => {
    let time = 0;
    const profiler = createFrameProfiler({ now: () => time });
    expect(profiler.clock()).toBe(0);
    profiler.add("flight", 0);
    profiler.frame();
    expect(profiler.summary().sections).toEqual([]);
    profiler.enabled = true;
    profiler.frame();
    time = 16;
    profiler.add("flight", 10);
    expect(profiler.current("flight")).toBe(6);
    profiler.frame();
    expect(profiler.summary().frames).toBe(1);
  });

  it("reads no clock while disabled", () => {
    const now = vi.fn(() => 0);
    const profiler = createFrameProfiler({ now });
    profiler.frame(); profiler.add("flight", 0); profiler.addDuration("gpu/globe", 1); profiler.clock();
    expect(now).not.toHaveBeenCalled();
  });

  it("hands each section's committed time to drain once, with the frames closed since", () => {
    const t = manual();
    t.profiler.frame();
    t.work("render", 3); t.at(16); t.profiler.frame();
    t.work("render", 2); t.work("sky", 1); t.at(32); t.profiler.frame();
    t.work("render", 7);
    const drained: Record<string, number> = {};
    expect(t.profiler.drain!((section, ms) => { drained[section] = ms; })).toBe(2);
    expect(drained).toEqual({ render: 5, sky: 1 });
    const again = vi.fn();
    expect(t.profiler.drain!(again)).toBe(0);
    expect(again).not.toHaveBeenCalled();
    t.at(48); t.profiler.frame();
    t.profiler.drain!((section, ms) => { drained[section] = ms; });
    expect(drained.render).toBe(7);
  });

  it("reports the 99th percentile of the frame interval", () => {
    const t = manual(200);
    let time = 0;
    for (let frame = 0; frame <= 200; frame++) {
      // Three intervals in two hundred are long: past the 95th percentile, inside the 99th.
      time += frame % 50 === 0 && frame > 0 && frame < 200 ? 50 : 10;
      t.at(time);
      t.profiler.frame();
    }
    const summary = t.profiler.summary().frame;
    expect(summary.p95Ms).toBe(10);
    expect(summary.maxMs).toBe(50);
    expect(summary.p99Ms).toBe(50);
  });

  it("keeps no trace unless asked, then each of the last frames whole with its tags", () => {
    const t = manual();
    t.at(0);
    t.profiler.frame();
    t.work("render", 4);
    t.at(16);
    t.profiler.frame();
    expect(t.profiler.trace()).toEqual({ capacity: 0, frames: [], bytes: 0 });

    t.profiler.configure({ traceFrames: 2 });
    for (let frame = 0; frame <= 3; frame++) {
      t.at(100 + frame * 16);
      t.profiler.frame();
      t.profiler.tag("engine frame", 40 + frame);
      t.work("render", frame);
    }
    const trace = t.profiler.trace();
    expect(trace.capacity).toBe(2);
    expect(trace.frames.map(frame => [frame.index, frame.intervalMs, frame.sections.render ?? 0, frame.tags["engine frame"]])).toEqual([
      [1, 16, 1, 41],
      [2, 16, 2, 42],
    ]);
    expect(trace.bytes).toBeGreaterThan(0);
  });

  it("starts afresh when the window or the trace changes size", () => {
    const t = manual(10);
    for (let frame = 0; frame <= 3; frame++) {
      t.at(frame * 10);
      t.profiler.frame();
    }
    expect(t.profiler.summary().frames).toBe(3);
    t.profiler.configure({ windowFrames: 10 });
    expect(t.profiler.summary().frames).toBe(3);
    t.profiler.configure({ windowFrames: 2 });
    expect(t.profiler.windowFrames).toBe(2);
    expect(t.profiler.summary().frames).toBe(0);
  });

  it("never adds background work to the frame, which it runs alongside", () => {
    const t = manual();
    t.at(0);
    t.profiler.frame();
    t.work("render", 4);
    t.profiler.addDuration("background/panorama decode", 30);
    t.at(16);
    t.profiler.frame();
    expect(t.profiler.summary().measuredMeanMs).toBe(4);
  });

  it("reads a WebGPU engine's render-pass GPU time, and hands the timing back when done", () => {
    const counter = { total: 0, count: 0 };
    let timing = false;
    const engine = {
      get enableGPUTimingMeasurements() { return timing; },
      set enableGPUTimingMeasurements(on: boolean) { timing = on; },
      get gpuTimeInFrameForMainPass() { return timing ? { counter } : undefined; },
    } as unknown as AbstractEngine;
    const observable = () => new Observable<Scene>();
    const scene = {
      onBeforeAnimationsObservable: observable(), onAfterRenderObservable: observable(),
      onBeforeActiveMeshesEvaluationObservable: observable(), onAfterActiveMeshesEvaluationObservable: observable(),
      onBeforeRenderTargetsRenderObservable: observable(), onAfterRenderTargetsRenderObservable: observable(),
      onBeforeDrawPhaseObservable: observable(), onAfterDrawPhaseObservable: observable(),
    } as unknown as Scene;
    const t = manual();
    const stop = profileBabylonScene(t.profiler, scene, engine);
    const render = (at: number) => {
      scene.onAfterRenderObservable.notifyObservers(scene);
      t.at(at);
      t.profiler.frame();
    };
    render(0);
    expect(timing).toBe(true);
    // Two frames complete at 3 ms and 5 ms, and a third is still collecting passes.
    Object.assign(counter, { total: 8e6, count: 3 });
    render(16);
    render(32);
    expect(t.profiler.summary().sections.find(section => section.section === "gpu/globe")?.meanMs).toBe(4);
    stop();
    expect(timing).toBe(false);
  });
});
