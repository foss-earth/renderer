import { describe, expect, it } from "vitest";
import { BABYLON_SHADER_GROUPS, babylonShaderChunks } from "../../src/vite/index.js";

const groupOf = (id: string): string | null => BABYLON_SHADER_GROUPS.find(group => group.test.test(id))?.name ?? null;

describe("public Babylon shader build support", () => {
  it("groups both shader languages and includes without capturing other code", () => {
    expect(groupOf("/app/node_modules/@babylonjs/core/Shaders/pbr.fragment.js")).toBe("babylon-shaders-glsl");
    expect(groupOf("/app/node_modules/@babylonjs/core/Shaders/ShadersInclude/pbrUboDeclaration.js")).toBe("babylon-shaders-glsl");
    expect(groupOf("/app/node_modules/@babylonjs/core/ShadersWGSL/pbr.fragment.js")).toBe("babylon-shaders-wgsl");
    expect(groupOf("/app/node_modules/@babylonjs/core/ShadersWGSL/ShadersInclude/pbrUboDeclaration.js")).toBe("babylon-shaders-wgsl");
    expect(groupOf("C:\\app\\node_modules\\@babylonjs\\core\\ShadersWGSL\\default.vertex.js")).toBe("babylon-shaders-wgsl");
    expect(groupOf("C:\\app\\node_modules\\@babylonjs\\core\\Shaders\\default.vertex.js")).toBe("babylon-shaders-glsl");
    for (const id of [
      "/app/node_modules/@babylonjs/core/Materials/PBR/pbrMaterial.js",
      "/app/node_modules/@babylonjs/core/Engines/shaderStore.js",
      "/app/node_modules/@babylonjs/core/ShadersWGSLExtra/default.vertex.js",
      "/app/node_modules/not-@babylonjs/core/Shaders/default.vertex.js",
      "/app/src/shaders/terrain.fragment.ts",
      "/app/src/phone.ts",
    ]) expect(groupOf(id)).toBeNull();
  });

  it("retains the exact Vite rolldown grouping hook and exposes groups for host composition", () => {
    const plugin = babylonShaderChunks();
    expect(plugin.name).toBe("foss-earth-babylon-shader-chunks");
    expect(typeof plugin.config).toBe("function");
    const config = (plugin.config as () => unknown)();
    expect(config).toEqual({ build: { rolldownOptions: { output: { codeSplitting: { groups: BABYLON_SHADER_GROUPS } } } } });
  });

  it("classifies repeated module observations consistently", () => {
    const glsl = "/app/node_modules/@babylonjs/core/Shaders/default.vertex.js";
    expect([groupOf(glsl), groupOf(glsl), groupOf(glsl)]).toEqual(Array(3).fill("babylon-shaders-glsl"));
  });
});
