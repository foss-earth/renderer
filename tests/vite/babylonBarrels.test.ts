import { describe, expect, it } from "vitest";
import { BABYLON_BARREL, babylonBarrels } from "../../src/vite/index.js";

type Handler = (code: string, id: string) => { code: string; moduleSideEffects: boolean } | null;

describe("public Babylon barrel build support", () => {
  it("matches core's index files only", () => {
    for (const id of [
      "/app/node_modules/@babylonjs/core/index.js",
      "/app/node_modules/@babylonjs/core/Materials/index.js",
      "/app/node_modules/@babylonjs/core/Engines/WebGPU/Extensions/index.js",
      "C:\\app\\node_modules\\@babylonjs\\core\\Meshes\\index.js",
    ]) expect(BABYLON_BARREL.test(id), id).toBe(true);
    for (const id of [
      // A loader's index registers the loader: an import of it for that alone must stay.
      "/app/node_modules/@babylonjs/loaders/glTF/index.js",
      "/app/node_modules/@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture.js",
      "/app/node_modules/@babylonjs/core/Shaders/default.vertex.js",
      "/app/node_modules/@babylonjs/core/Materials/index.ts",
      "/app/node_modules/@babylonjs/core/Materials/myindex.js",
      "/app/node_modules/not-@babylonjs/core/index.js",
      "/app/src/index.js",
    ]) expect(BABYLON_BARREL.test(id), id).toBe(false);
  });

  it("counts a barrel free of side effects in production builds and leaves its code alone", () => {
    const plugin = babylonBarrels();
    expect(plugin.name).toBe("foss-earth-babylon-barrels");
    expect(plugin.apply).toBe("build");
    const transform = plugin.transform as { filter: { id: RegExp }; handler: Handler };
    expect(transform.filter.id).toBe(BABYLON_BARREL);
    const code = 'export * from "./material.js";\n';
    expect(transform.handler(code, "/app/node_modules/@babylonjs/core/Materials/index.js")).toEqual({ code, map: null, moduleSideEffects: false });
  });
});
