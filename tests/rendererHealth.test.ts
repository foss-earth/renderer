import { FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { observeRendererHealth } from "../src/rendererHealth.js";

function fixture() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera("camera", Vector3.Zero(), scene);
  const device = new EventTarget();
  Object.assign(engine, { _device: device });
  let now = 100;
  const onError = vi.fn();
  const health = observeRendererHealth({ engine, scene, isRendering: () => false }, { now: () => now, onError });
  return { engine, scene, device, health, onError, advance: (ms: number) => { now += ms; },
    close() { health.dispose(); scene.dispose(); engine.dispose(); } };
}
function gpuError(device: EventTarget, message: string) {
  device.dispatchEvent(Object.assign(new Event("uncapturederror"), { error: { message, constructor: { name: "GPUValidationError" } } }));
}

describe("renderer health observations", () => {
  it("distinguishes preparation, scene rendering and CPU frame completion with ages, without scheduling work", () => {
    const f = fixture();
    try {
      f.engine.beginFrame(); f.advance(20);
      expect(f.health.snapshot()).toMatchObject({ phase: "preparing", phaseAgeMs: 20, frames: { begun: 1, ended: 0, lastEndAgeMs: null } });
      f.scene.render(); f.advance(5);
      expect(f.health.snapshot()).toMatchObject({ phase: "awaiting submission", frames: { sceneBegun: 1, sceneCompleted: 1, lastSceneAgeMs: 5, ended: 0 } });
      f.engine.endFrame(); f.advance(5000);
      expect(f.health.snapshot()).toMatchObject({ phase: "frame ended", schedulerActive: false, phaseAgeMs: 5000,
        frames: { begun: 1, ended: 1, lastBeginAgeMs: 5025, lastEndAgeMs: 5000 } });
    } finally { f.close(); }
  });

  it("retains the full first native cause and counts repeats even after console warning limits", () => {
    const f = fixture();
    try {
      const message = "Validation Error Caused by: ".repeat(30) + "Buffer engine-exhaust-scene-light has been destroyed";
      for (let i = 0; i < 50; i++) { gpuError(f.device, message); f.advance(1); }
      expect(f.onError).toHaveBeenCalledOnce();
      expect(f.health.snapshot().gpu).toMatchObject({ listening: true, errorCount: 50, droppedErrors: 0,
        errors: [{ name: "GPUValidationError", message, shortened: false, count: 50, firstMs: 100, lastMs: 149 }] });
      const snapshot = f.health.snapshot(); snapshot.gpu.errors[0].message = "edited";
      expect(f.health.snapshot().gpu.errors[0].message).toBe(message);
      for (let i = 0; i < 20; i++) gpuError(f.device, `failure ${i}`);
      expect(f.health.snapshot().gpu.errors).toHaveLength(8);
      expect(f.health.snapshot().gpu.errors[0].message).toBe(message);
      expect(f.health.snapshot().gpu.droppedErrors).toBe(13);
      expect(f.onError).toHaveBeenCalledTimes(4);
      gpuError(f.device, "x".repeat(40_000));
      expect(f.health.snapshot().gpu.errors.at(-1)).toMatchObject({ shortened: true });
      expect(f.health.snapshot().gpu.errors.at(-1)?.message.length).toBe(32_768);
    } finally { f.close(); }
  });

  it("detaches a lost/replaced device and all frame/error listeners on disposal", () => {
    const f = fixture();
    try {
      f.engine.onContextLostObservable.notifyObservers(f.engine);
      gpuError(f.device, "old device");
      const replacement = new EventTarget(); Object.assign(f.engine, { _device: replacement });
      f.engine.onContextRestoredObservable.notifyObservers(f.engine);
      gpuError(f.device, "stale device"); gpuError(replacement, "new device");
      expect(f.health.snapshot().gpu).toMatchObject({ lost: false, losses: 1, restorations: 1, errorCount: 1 });
      f.health.dispose(); f.engine.beginFrame(); gpuError(replacement, "late error");
      expect(f.health.snapshot().frames.begun).toBe(0);
      expect(f.health.snapshot().gpu.errorCount).toBe(1);
      expect(f.engine.onBeginFrameObservable.hasObservers()).toBe(false);
    } finally { f.close(); }
  });
});
