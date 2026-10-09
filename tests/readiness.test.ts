import { describe, expect, it, vi } from "vitest";
import { checkUntilSettled, type ReadinessTimers } from "../src/readiness.js";

function fakeTimers() {
  const calls: Array<{ callback: () => void; delay: number }> = [];
  const timers: ReadinessTimers = {
    setTimeout(callback, delay) { const entry = { callback, delay }; calls.push(entry); return entry; },
    clearTimeout(handle) { const index = calls.indexOf(handle as typeof calls[number]); if (index >= 0) calls.splice(index, 1); },
  };
  return { calls, timers, step() { calls.shift()?.callback(); } };
}

describe("generic readiness polling", () => {
  it("uses host policy, backs off, resets after progress and settles without drawing", () => {
    const clock = fakeTimers();
    const settled = vi.fn();
    let pending = 2;
    checkUntilSettled(pending, () => pending, settled, clock.timers, { firstCheckIntervalMs: 10, maxCheckIntervalMs: 40, backoffFactor: 2 });
    expect(clock.calls[0].delay).toBe(10);
    clock.step();
    expect(clock.calls[0].delay).toBe(20);
    clock.step();
    expect(clock.calls[0].delay).toBe(40);
    pending = 1;
    clock.step();
    expect(clock.calls[0].delay).toBe(10);
    pending = 0;
    clock.step();
    expect(settled).toHaveBeenCalledOnce();
    expect(clock.calls).toHaveLength(0);
  });

  it("cancellation ignores a callback that was already dequeued by the host", () => {
    const clock = fakeTimers();
    const settled = vi.fn();
    const cancel = checkUntilSettled(1, () => 0, settled, clock.timers);
    const callback = clock.calls[0].callback;
    cancel();
    cancel();
    callback();
    expect(settled).not.toHaveBeenCalled();
    expect(clock.calls).toHaveLength(0);
  });
});
