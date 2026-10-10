import { defineConfig, type Plugin } from "vite";
import { BABYLON_SHADER_GROUPS, babylonShaderChunks } from "@foss-earth/renderer/vite";
// @ts-expect-error Only the declared public build entry is exported.
import type { babylonShaderChunks as PrivateShaderChunks } from "@foss-earth/renderer/dist/vite/babylonShaderChunks.js";

export type PrivateRouteMustRemainUnresolvable = typeof PrivateShaderChunks;

const plugin: Plugin = babylonShaderChunks();
export const configured = defineConfig({ plugins: [plugin] });
export const hostGroups = defineConfig({
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "host-shaders", test: /host-shaders/ },
            ...BABYLON_SHADER_GROUPS,
          ],
        },
      },
    },
  },
});
