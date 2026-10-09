import type { AbstractEngine, Scene } from "@babylonjs/core";
import { createFrameProfiler, type FrameProfiler } from "../profiling/frameProfiler.js";
import { createFrameProfileSession as createSession, type FrameProfileSession } from "../profiling/frameProfileSession.js";
import { canTimeGpuFrames, profileBabylonScene } from "./frameProfiler.js";
export { bindFrameProfileSettings } from "../profiling/frameProfileSession.js";
export type { FrameProfileSession, GpuTimingStatus } from "../profiling/frameProfileSession.js";
export type FrameProfileSessionOptions = {
  scene: Scene;
  engine: AbstractEngine;
  gpuSection?: string;
} & ({ profiler: FrameProfiler; now?: () => number } | { profiler?: undefined; now: () => number });

/** Source-compatible scene measurement over the one supplied backend, with an explicit clock. */
export function createFrameProfileSession(options: FrameProfileSessionOptions): FrameProfileSession {
  const profiler = options.profiler ?? createFrameProfiler({ now: options.now! });
  return createSession({ profiler, gpuSection: options.gpuSection,
    measure: (target, gpuSection) => profileBabylonScene(target, options.scene, options.engine, { gpuSection }),
    canTimeGpuFrames: () => canTimeGpuFrames(options.engine),
  });
}
