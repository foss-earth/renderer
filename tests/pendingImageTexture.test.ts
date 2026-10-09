import { afterEach, describe, expect, it, vi } from "vitest";
import type { Scene } from "@babylonjs/core";
import { createPendingImageTexture, type PendingImageBody } from "../src/babylon/pendingImageTexture.js";
const state = vi.hoisted(() => ({ updateURL: vi.fn(), disposed: null as (() => void) | null, loaded: null as (() => void) | null, args: [] as unknown[] }));
vi.mock("@babylonjs/core", () => ({ Texture: class {
  static TRILINEAR_SAMPLINGMODE = 3;
  constructor(...args: unknown[]) { state.args = args; state.loaded = args[5] as () => void; }
  onDisposeObservable = { add(callback: () => void) { state.disposed = callback; } };
  updateURL = state.updateURL;
} }));
afterEach(() => { vi.clearAllMocks(); });
function fixture(acquire: (signal: AbortSignal) => Promise<PendingImageBody>) {
  const createObjectURL = vi.fn(() => "blob:fixture");
  const revokeObjectURL = vi.fn();
  const onLoad = vi.fn(), onError = vi.fn();
  const texture = createPendingImageTexture({ scene: {} as Scene, label: "map", acquire, createObjectURL, revokeObjectURL, onLoad, onError });
  return { texture, createObjectURL, revokeObjectURL, onLoad, onError };
}
describe("legacy pending image device adapter", () => {
  it("preserves Babylon mip/flip/trilinear defaults and holds the blob through decode", async () => {
    const release = vi.fn();
    const acquire = vi.fn(async () => ({ blob: new Blob(["pixels"]), release }));
    const h = fixture(acquire);
    await vi.waitFor(() => expect(state.updateURL).toHaveBeenCalledWith("blob:fixture"));
    expect(state.args.slice(2, 5)).toEqual([false, false, 3]);
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    state.loaded?.(); state.disposed?.();
    expect(h.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:fixture");
    expect(release).toHaveBeenCalledOnce();
    expect(h.onLoad).toHaveBeenCalledOnce();
  });
  it("releases late acquisition after disposal without publishing a URL", async () => {
    let arrived!: (body: PendingImageBody) => void;
    const h = fixture(() => new Promise(resolve => { arrived = resolve; }));
    await Promise.resolve(); state.disposed?.();
    const release = vi.fn(); arrived({ blob: new Blob(["pixels"]), release });
    await Promise.resolve(); await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(h.createObjectURL).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });
  it("reports acquisition failure without decoding", async () => {
    const h = fixture(() => { throw new Error("Acquisition failed"); });
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalled());
    expect(state.updateURL).not.toHaveBeenCalled();
  });
});
