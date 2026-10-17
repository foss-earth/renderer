/**
 * Bundle only the Babylon modules an application uses (optimization backlog S1).
 * Babylon 8.56.2 declares every file as having side effects, its index files too,
 * so one name imported from "@babylonjs/core" keeps the whole library, both shader
 * languages, audio and the flow graph among it. The index files only re-export:
 * counted free of side effects, a name brings the module that defines it and that
 * module's own imports, and nothing else.
 *
 * What the left-out modules did as side effects is then missing: prototype methods
 * that extension modules add (dynamic textures on WebGPU, edges rendering, GPU
 * timers) and shaders registered by name. A module that relies on one imports it
 * itself, as Babylon's guide to ES6 imports says. docs/vite.md lists the ones the
 * FOSS Earth packages import.
 */
import type { Plugin } from "vite";

/** Babylon core's index files, which only re-export. */
export const BABYLON_BARREL = /[\\/]@babylonjs[\\/]core[\\/](?:[^\\/]+[\\/])*index\.js$/;

export function babylonBarrels(): Plugin {
  return {
    name: "foss-earth-babylon-barrels",
    apply: "build",
    transform: {
      filter: { id: BABYLON_BARREL },
      handler: code => ({ code, map: null, moduleSideEffects: false }),
    },
  };
}
