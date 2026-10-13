import { describe, expect, it, vi } from "vitest";
import { createBrowserRenderScheduler, observeResourceTiming, readHeapBytes } from "../src/browser.js";

describe("optional browser scheduler adapter", () => {
  it("forwards to one supplied host frame queue without starting work on creation", () => {
    const frames: Array<(time: number) => void> = [];
    const tick = vi.fn();
    const scheduler = createBrowserRenderScheduler({
      tick,
      host: { requestAnimationFrame(callback) { frames.push(callback); return frames.length; }, cancelAnimationFrame: vi.fn() },
    });
    expect(frames).toHaveLength(0);
    scheduler.requestRender();
    scheduler.requestRender();
    expect(frames).toHaveLength(1);
    frames.shift()!(1);
    expect(tick).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(0);
  });
});

describe("browser profiling adapters", () => {
  it("observes finished requests only between start and stop", () => {
    const observers: Array<{ callback: (list: { getEntries(): readonly unknown[] }) => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
    class Observer {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(public callback: (list: { getEntries(): readonly unknown[] }) => void) { observers.push(this); }
    }
    const observe = observeResourceTiming({ PerformanceObserver: Observer });
    expect(observers).toHaveLength(0);
    const listener = vi.fn();
    const stop = observe(listener);
    expect(observers).toHaveLength(1);
    expect(observers[0].observe).toHaveBeenCalledWith({ type: "resource" });
    observers[0].callback({ getEntries: () => [{ name: "a" }] });
    expect(listener).toHaveBeenCalledWith([{ name: "a" }]);
    stop();
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(observeResourceTiming({})(listener)).toBeTypeOf("function");
  });

  it("reads Chromium's heap figure when there is one", () => {
    expect(readHeapBytes({ performance: { memory: { usedJSHeapSize: 1234 } } })()).toBe(1234);
    expect(readHeapBytes({ performance: {} })()).toBeNull();
    expect(readHeapBytes({})()).toBeNull();
  });
});
