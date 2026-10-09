import { describe, expect, it, vi } from "vitest";
import { createBrowserRenderScheduler } from "../src/browser.js";

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
