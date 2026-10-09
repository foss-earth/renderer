import { describe, expect, it, vi } from "vitest";
import { createRendererResourceLifecycle } from "../src/resourceLifecycle.js";

const identity = { rendererId: "host-renderer", backendId: "supplied-webgpu", deviceId: "host-device" };
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

describe("host renderer resource lifecycle", () => {
  it("waits hidden, shows only when ready and uses the supplied frame authority", async () => {
    const requestRender = vi.fn();
    const owner = createRendererResourceLifecycle({ identity, requestRender });
    const wait = deferred();
    const show = vi.fn();
    const whenReady = vi.fn(() => wait.promise);
    const resource = owner.adopt(owner.currentGeneration(), { value: "texture", dispose: vi.fn(), whenReady })!;
    const committed = resource.commitVisible(show);
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
    wait.resolve();
    await expect(committed).resolves.toBe(true);
    expect(show).toHaveBeenCalledExactlyOnceWith("texture");
    expect(requestRender).toHaveBeenCalledOnce();
    await resource.ready();
    expect(whenReady).toHaveBeenCalledOnce();
  });

  it("disposes a loader's stale result without waiting, showing or requesting a frame", () => {
    const requestRender = vi.fn();
    const owner = createRendererResourceLifecycle({ identity, requestRender });
    const generation = owner.currentGeneration();
    owner.invalidate({ ...identity, deviceId: "replacement-device" });
    const dispose = vi.fn();
    const whenReady = vi.fn();
    expect(owner.adopt(generation, { value: "late-resource", dispose, whenReady })).toBeNull();
    expect(dispose).toHaveBeenCalledExactlyOnceWith("late-resource");
    expect(whenReady).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("rejects a foreign token even when identities and sequence match", () => {
    const a = createRendererResourceLifecycle({ identity, requestRender: vi.fn() });
    const b = createRendererResourceLifecycle({ identity, requestRender: vi.fn() });
    const dispose = vi.fn();
    expect(b.adopt(a.currentGeneration(), { value: "foreign", dispose })).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects readiness that completes after generation replacement and disposes once", async () => {
    const requestRender = vi.fn();
    const owner = createRendererResourceLifecycle({ identity, requestRender });
    const wait = deferred();
    const dispose = vi.fn();
    const show = vi.fn();
    const resource = owner.adopt(owner.currentGeneration(), { value: {}, dispose, whenReady: () => wait.promise })!;
    const committed = resource.commitVisible(show);
    await Promise.resolve();
    owner.invalidate();
    wait.resolve();
    await expect(committed).resolves.toBe(false);
    resource.dispose();
    owner.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("ignores a late readiness failure from a disposed resource", async () => {
    const owner = createRendererResourceLifecycle({ identity, requestRender: vi.fn() });
    const wait = deferred();
    const dispose = vi.fn();
    const resource = owner.adopt(owner.currentGeneration(), { value: {}, dispose, whenReady: () => wait.promise })!;
    const ready = resource.ready();
    await Promise.resolve();
    resource.dispose();
    wait.reject(new Error("retired device"));
    await expect(ready).resolves.toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes failed current resources and exposes the original readiness error", async () => {
    const owner = createRendererResourceLifecycle({ identity, requestRender: vi.fn() });
    const failure = new Error("upload failed");
    const dispose = vi.fn();
    const resource = owner.adopt(owner.currentGeneration(), { value: {}, dispose, whenReady: async () => { throw failure; } })!;
    await expect(resource.ready()).rejects.toBe(failure);
    expect(resource.isCurrent()).toBe(false);
    resource.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes hidden resources silently and removes visible resources with one request", async () => {
    const requestRender = vi.fn();
    const owner = createRendererResourceLifecycle({ identity, requestRender });
    const dispose = vi.fn();
    const hidden = owner.adopt(owner.currentGeneration(), { value: "hidden", dispose })!;
    const shown = owner.adopt(owner.currentGeneration(), { value: "shown", dispose })!;
    hidden.dispose();
    hidden.dispose();
    expect(requestRender).not.toHaveBeenCalled();
    await shown.commitVisible(() => undefined);
    requestRender.mockClear();
    shown.dispose();
    shown.dispose();
    expect(requestRender).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("retires all resources and coalesces visible removals even if one disposer fails", async () => {
    const requestRender = vi.fn();
    const owner = createRendererResourceLifecycle({ identity, requestRender });
    const goodDispose = vi.fn();
    const badDispose = vi.fn(() => { throw new Error("release failed"); });
    owner.adopt(owner.currentGeneration(), { value: "a", dispose: badDispose, initiallyVisible: true });
    owner.adopt(owner.currentGeneration(), { value: "b", dispose: goodDispose, initiallyVisible: true });
    expect(() => owner.dispose()).toThrow(AggregateError);
    expect(goodDispose).toHaveBeenCalledOnce();
    expect(badDispose).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalledOnce();
    owner.dispose();
    const lateDispose = vi.fn();
    expect(owner.adopt(owner.currentGeneration(), { value: "late", dispose: lateDispose })).toBeNull();
    expect(lateDispose).toHaveBeenCalledOnce();
  });
});
