import { HemisphericLight, Mesh, MeshBuilder, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSceneUpdates, whenMeshesReady, type SceneUpdates } from "./sceneUpdates";

let engine: NullEngine;
let scene: Scene;
let updates: SceneUpdates | null;
let preparing: boolean;
let requestRender: ReturnType<typeof vi.fn>;

/**
 * Lets Babylon report what was added - a millisecond later, on a timer - and
 * the judgement after it run.
 */
const reported = () => vi.advanceTimersByTimeAsync(2);

/** A mesh whose readiness the test decides, as a material still compiling would. */
function pendingMesh(name: string, ready: { value: boolean }): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene);
  // Geometry is there; only the complete check, which the material answers, fails.
  vi.spyOn(mesh, "isReady").mockImplementation((completeCheck?: boolean) => !completeCheck || ready.value);
  return mesh;
}

/** The meshes the last frame meant to draw, as Babylon leaves them after a render. */
function lastFrameDrew(...meshes: Mesh[]): void {
  vi.spyOn(scene, "getActiveMeshes").mockReturnValue({ length: meshes.length, data: meshes } as never);
}

beforeEach(() => {
  // Timers only: additions are judged in a microtask, which must stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  engine = new NullEngine();
  scene = new Scene(engine);
  preparing = false;
  requestRender = vi.fn();
  updates = createSceneUpdates({ scene, requestRender, isPreparingFrame: () => preparing });
});

afterEach(async () => {
  // Babylon's queue of additions to report is shared by every scene: drain it
  // while its timer is still fake, or the next test's reports never arrive.
  await reported();
  updates?.dispose();
  scene.dispose();
  engine.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("what enters and leaves the scene", () => {
  it("asks for one frame for everything added in one task", async () => {
    MeshBuilder.CreateBox("a", { size: 1 }, scene);
    MeshBuilder.CreateBox("b", { size: 1 }, scene);
    expect(requestRender).not.toHaveBeenCalled();
    await reported();
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("asks for nothing for a mesh the last frame already drew", async () => {
    // Added while that frame was being prepared: Babylon reports it after.
    const box = MeshBuilder.CreateBox("in-tick", { size: 1 }, scene);
    lastFrameDrew(box);
    await reported();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("asks for nothing for a model added under a hidden node, nor when it is taken away", async () => {
    const holder = new TransformNode("holder", scene);
    holder.setEnabled(false);
    // Added and then hidden in the same task, as a loader adds a model and its
    // owner parents it: judged once the task is over, it was never shown.
    const box = MeshBuilder.CreateBox("staged", { size: 1 }, scene);
    box.parent = holder;
    await reported();
    expect(requestRender).not.toHaveBeenCalled();
    box.dispose();
    await reported();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("asks for a frame when a mesh the last frame drew is taken away", async () => {
    const box = MeshBuilder.CreateBox("shown", { size: 1 }, scene);
    await reported();
    lastFrameDrew(box);
    requestRender.mockClear();
    box.dispose();
    await reported();
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("asks for nothing when what is taken away was not drawn, or a frame is being prepared", async () => {
    const offscreen = MeshBuilder.CreateBox("offscreen", { size: 1 }, scene);
    const drawnNow = MeshBuilder.CreateBox("drawn", { size: 1 }, scene);
    await reported();
    lastFrameDrew(drawnNow);
    requestRender.mockClear();
    offscreen.dispose();
    await reported();
    expect(requestRender).not.toHaveBeenCalled();
    preparing = true;
    drawnNow.dispose();
    await reported();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("asks for a frame when a light comes or goes", async () => {
    const light = new HemisphericLight("sun", new Vector3(0, 1, 0), scene);
    await reported();
    expect(requestRender).toHaveBeenCalledOnce();
    light.dispose();
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("stops watching once disposed", async () => {
    updates!.dispose();
    updates = null;
    MeshBuilder.CreateBox("late", { size: 1 }, scene);
    await reported();
    expect(requestRender).not.toHaveBeenCalled();
  });
});

describe("a frame that could not draw everything", () => {
  it("asks for exactly one more frame once what it skipped is ready, and draws none while waiting", async () => {
    const ready = { value: false };
    const model = pendingMesh("compiling", ready);
    await reported();
    requestRender.mockClear();
    lastFrameDrew(model);
    updates!.settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(requestRender).not.toHaveBeenCalled();
    ready.value = true;
    await vi.advanceTimersByTimeAsync(300);
    expect(requestRender).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("does nothing, and sets no timer, when the frame drew everything", async () => {
    const model = pendingMesh("compiled", { value: true });
    await reported();
    requestRender.mockClear();
    lastFrameDrew(model);
    updates!.settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(requestRender).not.toHaveBeenCalled();
  });

  it("checks less often the longer nothing gets ready, but never stops", async () => {
    const ready = { value: false };
    const model = pendingMesh("slow", ready);
    lastFrameDrew(model);
    const checks = vi.mocked(model.isReady);
    checks.mockClear();
    updates!.settle();
    await vi.advanceTimersByTimeAsync(100);
    const early = checks.mock.calls.length;
    checks.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    // A frame apart at first, a quarter of a second apart at most.
    expect(early).toBeGreaterThanOrEqual(3);
    expect(checks.mock.calls.length).toBeLessThanOrEqual(44);
    expect(checks.mock.calls.length).toBeGreaterThanOrEqual(36);
  });

  it("stops waiting when a frame is coming anyway", async () => {
    const ready = { value: false };
    lastFrameDrew(pendingMesh("compiling", ready));
    requestRender.mockClear();
    updates!.settle();
    updates!.cancelSettle();
    ready.value = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no longer waits for a mesh that was hidden or disposed meanwhile", async () => {
    const hidden = pendingMesh("hidden", { value: false });
    const gone = pendingMesh("gone", { value: false });
    lastFrameDrew(hidden, gone);
    requestRender.mockClear();
    updates!.settle();
    hidden.setEnabled(false);
    gone.dispose();
    // Taking away a mesh the frame drew asks for its own frame; in the runtime
    // that frame's start cancels the wait.
    await reported();
    requestRender.mockClear();
    await vi.advanceTimersByTimeAsync(100);
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("does not wait for a material that failed to compile", async () => {
    const broken = pendingMesh("broken", { value: false });
    await reported();
    vi.spyOn(broken.subMeshes[0], "effect", "get").mockReturnValue({
      getCompilationError: () => "ERROR: 0:1: syntax error",
      allFallbacksProcessed: () => true,
    } as never);
    lastFrameDrew(broken);
    requestRender.mockClear();
    updates!.settle();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("whenMeshesReady", () => {
  it("resolves once every mesh can be drawn, checking hidden meshes no frame touches", async () => {
    const ready = { value: false };
    const holder = new TransformNode("holder", scene);
    holder.setEnabled(false);
    const model = pendingMesh("hidden-model", ready);
    model.parent = holder;
    const done = vi.fn();
    void whenMeshesReady([model]).then(done);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).not.toHaveBeenCalled();
    // Hidden is not ready: it is what a mesh is while it gets ready.
    expect(model.isReady).toHaveBeenCalledWith(true);
    ready.value = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toHaveBeenCalledOnce();
  });

  it("resolves at once when there is nothing to wait for", async () => {
    const model = pendingMesh("ready", { value: true });
    await reported();
    await expect(whenMeshesReady([model])).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects and stops checking when cancelled", async () => {
    const controller = new AbortController();
    const model = pendingMesh("never", { value: false });
    await reported();
    const waiting = whenMeshesReady([model], { signal: controller.signal });
    controller.abort(new Error("switched away"));
    await expect(waiting).rejects.toThrow("switched away");
    expect(vi.getTimerCount()).toBe(0);
  });
});
