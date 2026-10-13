import { describe, expect, it, vi } from "vitest";
import { createFrameProfiler } from "../src/profiling/frameProfiler.js";
import { bindFrameProfileSettings, createFrameProfileSession } from "../src/profiling/frameProfileSession.js";

describe("injected profiling lifetime", () => {
  it("rolls back earlier settings watches on startup failure without disposing the borrowed session", () => {
    const session = createFrameProfileSession({ profiler: createFrameProfiler({ now: () => 0 }), measure: () => () => {}, canTimeGpuFrames: () => false });
    const dispose = vi.spyOn(session, "dispose");
    const configure = vi.spyOn(session, "configure");
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const stale: Array<() => void> = [];
    const settings = { get: (id: string) => id.endsWith("enabled") ? false : 20, watch(_id: string, listener: () => void) {
      if (stops.length === 2) throw new Error("watch refused");
      stale.push(listener); const stop = vi.fn(); stops.push(stop); return stop;
    } };
    try {
      expect(() => bindFrameProfileSettings(settings, session)).toThrow("watch refused");
      expect(stops).toHaveLength(2); for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
      configure.mockClear(); for (const callback of stale) callback();
      expect(configure).not.toHaveBeenCalled(); expect(dispose).not.toHaveBeenCalled();
    } finally { session.dispose(); }
  });

  it("detaches every watch once after one throws and ignores stale callbacks", () => {
    const session = createFrameProfileSession({ profiler: createFrameProfiler({ now: () => 0 }), measure: () => () => {}, canTimeGpuFrames: () => false });
    const configure = vi.spyOn(session, "configure");
    const stale: Array<() => void> = [];
    const stops = [vi.fn(() => { throw new Error("stop failed"); }), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    const settings = { get: (id: string) => id.endsWith("enabled") ? false : 20, watch(_id: string, listener: () => void) { stale.push(listener); return stops[stale.length - 1]; } };
    const detach = bindFrameProfileSettings(settings, session);
    try {
      expect(() => detach()).toThrow("Frame profile settings cleanup failed"); detach();
      for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
      configure.mockClear(); for (const callback of stale) callback(); expect(configure).not.toHaveBeenCalled();
      expect(session.enabled).toBe(false);
    } finally { session.dispose(); }
  });

  it("uses only the supplied clock and attaches an already enabled profiler exactly once", () => {
    let at = 0;
    const now = vi.fn(() => at);
    const profiler = createFrameProfiler({ now, enabled: true });
    const detach = vi.fn(); const measure = vi.fn(() => detach);
    const session = createFrameProfileSession({ profiler, measure, canTimeGpuFrames: () => false });
    session.setEnabled(true);
    expect(measure).toHaveBeenCalledOnce();
    session.frame(); at = 3; profiler.add("render", 0); at = 16; session.frame();
    expect(profiler.summary().sections[0].meanMs).toBe(3);
    expect(now).toHaveBeenCalled();
    session.dispose(); session.dispose(); session.setEnabled(true);
    expect(detach).toHaveBeenCalledOnce(); expect(measure).toHaveBeenCalledOnce();
  });
  it("permanently releases a throwing measurement teardown without reattaching", () => {
    const stop = vi.fn(() => { throw new Error("Detach failed"); });
    const measure = vi.fn(() => stop);
    const session = createFrameProfileSession({ profiler: createFrameProfiler({ now: () => 0 }), measure, canTimeGpuFrames: () => false });
    session.setEnabled(true);
    expect(() => session.dispose()).toThrow("Detach failed");
    session.dispose(); session.setEnabled(true);
    expect(stop).toHaveBeenCalledOnce(); expect(measure).toHaveBeenCalledOnce();
    expect(session.enabled).toBe(false);
  });
});
