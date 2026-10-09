import { Observable, type AbstractEngine, type Scene } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { FRAME_PROFILING_IDS, frameProfilingParameters } from "../src/settings/profiling.js";
import { bindFrameProfileSettings, createFrameProfileSession } from "../src/babylon/frameProfileSession.js";

function fakeScene() {
  const observable = () => new Observable<Scene>();
  const scene = {
    onBeforeAnimationsObservable: observable(), onAfterRenderObservable: observable(),
    onBeforeActiveMeshesEvaluationObservable: observable(), onAfterActiveMeshesEvaluationObservable: observable(),
    onBeforeRenderTargetsRenderObservable: observable(), onAfterRenderTargetsRenderObservable: observable(),
    onBeforeDrawPhaseObservable: observable(), onAfterDrawPhaseObservable: observable(),
  };
  // Babylon removes an observer lazily; `hasObservers` counts only live ones.
  const observers = () => Object.values(scene).filter(entry => entry.hasObservers()).length;
  return { scene: scene as unknown as Scene, observers };
}

const engine = { getCaps: () => ({}) } as unknown as AbstractEngine;

describe("frame profile session", () => {
  it("attaches to the scene only while measuring, and releases everything when disposed", () => {
    const { scene, observers } = fakeScene();
    const session = createFrameProfileSession({ scene, engine, now: () => 0 });
    expect(session.enabled).toBe(false);
    expect(observers()).toBe(0);
    let changes = 0;
    session.onChange(() => { changes += 1; });
    session.setEnabled(true);
    expect(observers()).toBeGreaterThan(0);
    session.setEnabled(true);
    const attached = observers();
    session.setEnabled(false);
    expect(observers()).toBe(0);
    expect(changes).toBe(2);
    session.setEnabled(true);
    expect(observers()).toBe(attached);
    session.dispose();
    expect(observers()).toBe(0);
    session.setEnabled(true);
    expect(observers()).toBe(0);
  });

  it("says a renderer that cannot time the GPU is unsupported, not 0", () => {
    const { scene } = fakeScene();
    const session = createFrameProfileSession({ scene, engine, now: () => 0 });
    expect(session.gpuTimed()).toBe(false);
    expect(session.gpuStatus()).toBe("unsupported");
  });

  it("follows the profiling parameters, which last only for the session", () => {
    const { scene, observers } = fakeScene();
    const session = createFrameProfileSession({ scene, engine, now: () => 0 });
    const settings = createSettingsRegistry({ storage: null });
    settings.register(frameProfilingParameters({ tab: "renderer", section: "performance" }));
    const stop = bindFrameProfileSettings(settings, session);
    expect(session.enabled).toBe(false);
    expect(session.profiler.windowFrames).toBe(600);
    expect(session.profiler.traceFrames).toBe(0);
    settings.set(FRAME_PROFILING_IDS.enabled, true);
    settings.set(FRAME_PROFILING_IDS.traceFrames, 1200);
    expect(session.enabled).toBe(true);
    expect(observers()).toBeGreaterThan(0);
    expect(session.profiler.traceFrames).toBe(1200);
    expect(settings.spec(FRAME_PROFILING_IDS.enabled)?.session).toBe(true);
    stop();
    settings.set(FRAME_PROFILING_IDS.enabled, false);
    expect(session.enabled).toBe(true);
    session.dispose();
  });
});
