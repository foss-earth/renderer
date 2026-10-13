import type { AbstractEngine, Scene } from "@babylonjs/core";
import { createFrameProfiler, type FrameProfiler } from "../profiling/frameProfiler.js";
import { createFrameProfileSession as createSession, type FrameProfileSession } from "../profiling/frameProfileSession.js";
import { canTimeGpuFrames, profileBabylonScene } from "./frameProfiler.js";
import { createGpuMemorySource } from "./gpuMemorySource.js";
export { bindFrameProfileSettings } from "../profiling/frameProfileSession.js";
export type { FrameProfileSession, GpuTimingStatus } from "../profiling/frameProfileSession.js";
export type FrameProfileSessionOptions = {
  scene: Scene;
  engine: AbstractEngine;
  gpuSection?: string;
  /** The owner of a named texture or mesh in the GPU memory stream; the name's first word when omitted or null. */
  gpuMemoryOwner?(name: string, kind: "texture" | "mesh"): string | null;
} & ({ profiler: FrameProfiler; now?: () => number } | { profiler?: undefined; now: () => number });

/**
 * Source-compatible scene measurement over the one supplied backend, with an
 * explicit clock. Its streams estimate GPU memory from the scene's textures
 * and buffers while measuring.
 */
export function createFrameProfileSession(options: FrameProfileSessionOptions): FrameProfileSession {
  const profiler = options.profiler ?? createFrameProfiler({ now: options.now! });
  const session = createSession({ profiler, gpuSection: options.gpuSection,
    measure: (target, gpuSection) => profileBabylonScene(target, options.scene, options.engine, { gpuSection }),
    canTimeGpuFrames: () => canTimeGpuFrames(options.engine),
  });
  session.streams.register(createGpuMemorySource({ engine: options.engine, scene: options.scene, owner: options.gpuMemoryOwner }));
  return session;
}
