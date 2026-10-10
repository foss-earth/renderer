/**
 * Keep Babylon's side-effect shader registrations together when the renderer is
 * loaded lazily. This is the retained Vite 8.3.4 / Babylon 8.56.2 repair; it changes
 * chunk placement, not which shader code an application imports.
 */
import type { Plugin } from "vite";

/** The groups, by module path, for a host that supplies its own codeSplitting groups. */
export const BABYLON_SHADER_GROUPS = [
  { name: "babylon-shaders-glsl", test: /[\\/]@babylonjs[\\/]core[\\/]Shaders[\\/]/ },
  { name: "babylon-shaders-wgsl", test: /[\\/]@babylonjs[\\/]core[\\/]ShadersWGSL[\\/]/ },
];

export function babylonShaderChunks(): Plugin {
  return {
    name: "foss-earth-babylon-shader-chunks",
    config: () => ({ build: { rolldownOptions: { output: { codeSplitting: { groups: BABYLON_SHADER_GROUPS } } } } }),
  };
}
