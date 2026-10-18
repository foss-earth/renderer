import type { IndexHtmlTransformContext, Rolldown } from "vite";
import { describe, expect, it } from "vitest";
import { SHADER_CHUNKS_ELEMENT_ID } from "../../src/shaderChunks.js";
import { BABYLON_SHADER_GROUPS, babylonShaderChunks } from "../../src/vite/index.js";

const core = "/app/node_modules/@babylonjs/core/";

/** The group a module goes to, as Rolldown picks it, given each module's importers. */
function groupOf(id: string, importers: Record<string, string[]> = {}): string | null {
  const graph = { getModuleInfo: (module: string) => ({ importers: importers[module] ?? [] }) } as unknown as Rolldown.ChunkingContext;
  for (const group of BABYLON_SHADER_GROUPS) {
    // Each of these groups is tested by a module's path.
    if (!(group.test as RegExp).test(id)) continue;
    const name = typeof group.name === "function" ? group.name(id, graph) : group.name;
    if (name) return name;
  }
  return null;
}

function chunk(fileName: string, name: string, imports: string[] = [], dynamicImports: string[] = []): Rolldown.OutputChunk {
  return { type: "chunk", fileName, name, imports, dynamicImports } as unknown as Rolldown.OutputChunk;
}

/** Runs the plugin's page transform for a page of a build with these chunks. */
function transformPage(base: string, path: string, entry: string, chunks: Rolldown.OutputChunk[]): unknown {
  const plugin = babylonShaderChunks();
  (plugin.configResolved as (config: { base: string }) => void)({ base });
  const bundle = Object.fromEntries(chunks.map(output => [output.fileName, output]));
  const ctx = { path, filename: `/site${path}`, bundle, chunk: bundle[entry] } as unknown as IndexHtmlTransformContext;
  return (plugin.transformIndexHtml as (html: string, ctx: IndexHtmlTransformContext) => unknown)("<html></html>", ctx);
}

const page = [
  chunk("assets/index-a.js", "index", ["assets/vendor-b.js"], ["assets/scene-c.js"]),
  chunk("assets/vendor-b.js", "vendor"),
  chunk("assets/scene-c.js", "scene", ["assets/babylon-shader-store-d.js"], ["assets/babylon-shaders-glsl-e.js", "assets/babylon-shaders-wgsl-f.js"]),
  chunk("assets/babylon-shader-store-d.js", "babylon-shader-store"),
  chunk("assets/babylon-shaders-glsl-e.js", "babylon-shaders-glsl", ["assets/babylon-shader-store-d.js"]),
  chunk("assets/babylon-shaders-wgsl-f.js", "babylon-shaders-wgsl", ["assets/babylon-shader-store-d.js"]),
];

describe("public Babylon shader build support", () => {
  it("groups each language's shaders and includes without capturing other code", () => {
    expect(groupOf(`${core}Shaders/pbr.fragment.js`)).toBe("babylon-shaders-glsl");
    expect(groupOf(`${core}Shaders/ShadersInclude/pbrUboDeclaration.js`)).toBe("babylon-shaders-glsl");
    expect(groupOf(`${core}ShadersWGSL/pbr.fragment.js`)).toBe("babylon-shaders-wgsl");
    expect(groupOf(`${core}ShadersWGSL/ShadersInclude/pbrUboDeclaration.js`)).toBe("babylon-shaders-wgsl");
    expect(groupOf("C:\\app\\node_modules\\@babylonjs\\core\\ShadersWGSL\\default.vertex.js")).toBe("babylon-shaders-wgsl");
    expect(groupOf("C:\\app\\node_modules\\@babylonjs\\core\\Shaders\\default.vertex.js")).toBe("babylon-shaders-glsl");
    for (const id of [
      `${core}Materials/PBR/pbrMaterial.js`,
      `${core}Engines/shaderStore.json`,
      `${core}ShadersWGSLExtra/default.vertex.js`,
      "/app/node_modules/not-@babylonjs/core/Shaders/default.vertex.js",
      "/app/src/shaders/terrain.fragment.ts",
      "/app/src/phone.ts",
    ]) expect(groupOf(id)).toBeNull();
  });

  it("gives the shader store a chunk of its own, so that the code that compiles shaders does not load a language", () => {
    expect(groupOf(`${core}Engines/shaderStore.js`)).toBe("babylon-shader-store");
    expect(groupOf("C:\\app\\node_modules\\@babylonjs\\core\\Engines\\shaderStore.js")).toBe("babylon-shader-store");
  });

  it("puts the shaders that code imports statically, also through other shaders, in one chunk that loads with that code", () => {
    const clear = `${core}ShadersWGSL/clearQuad.vertex.js`;
    const include = `${core}ShadersWGSL/ShadersInclude/clipPlaneVertex.js`;
    const lazy = `${core}ShadersWGSL/pbr.vertex.js`;
    const importers = {
      [clear]: [`${core}Engines/WebGPU/webgpuClearQuad.js`],
      [include]: [clear, lazy],
      [lazy]: [],
    };
    expect(groupOf(clear, importers)).toBe("babylon-shaders-static");
    expect(groupOf(include, importers)).toBe("babylon-shaders-static");
    expect(groupOf(lazy, importers)).toBe("babylon-shaders-wgsl");
    const postprocess = `${core}Shaders/postprocess.vertex.js`;
    expect(groupOf(postprocess, { [postprocess]: ["/app/src/exhaust.ts"] })).toBe("babylon-shaders-static");
  });

  it("does not count Babylon's index files, nor a cycle of shaders, as importing a shader statically", () => {
    const shader = `${core}Shaders/default.fragment.js`;
    const include = `${core}Shaders/ShadersInclude/helperFunctions.js`;
    const importers = {
      [shader]: [`${core}Shaders/index.js`, `${core}index.js`, include],
      [include]: [shader],
    };
    expect(groupOf(shader, importers)).toBe("babylon-shaders-glsl");
    expect(groupOf(include, importers)).toBe("babylon-shaders-glsl");
  });

  it("leaves each shader's imports to their own groups", () => {
    for (const group of BABYLON_SHADER_GROUPS.filter(group => group.debugName?.startsWith("babylon-shaders-"))) {
      expect(group.includeDependenciesRecursively).toBe(false);
    }
  });

  it("retains the exact Vite rolldown grouping hook and exposes groups for host composition", () => {
    const plugin = babylonShaderChunks();
    expect(plugin.name).toBe("foss-earth-babylon-shader-chunks");
    expect(typeof plugin.config).toBe("function");
    const config = (plugin.config as () => unknown)();
    expect(config).toEqual({ build: { rolldownOptions: { output: { codeSplitting: { groups: BABYLON_SHADER_GROUPS } } } } });
    expect(BABYLON_SHADER_GROUPS.map(group => group.debugName ?? group.name)).toEqual(["babylon-shader-store", "babylon-shaders-static", "babylon-shaders-glsl", "babylon-shaders-wgsl"]);
  });

  it("classifies repeated module observations consistently", () => {
    const glsl = `${core}Shaders/default.vertex.js`;
    expect([groupOf(glsl), groupOf(glsl), groupOf(glsl)]).toEqual(Array(3).fill("babylon-shaders-glsl"));
  });
});

describe("the page's names for its shader chunks", () => {
  const named = (urls: Record<string, string>) => [{
    tag: "script",
    attrs: { type: "application/json", id: SHADER_CHUNKS_ELEMENT_ID },
    children: JSON.stringify(urls),
    injectTo: "head",
  }];

  it("names each language's chunk that the page's code can import, under an absolute base", () => {
    expect(transformPage("/app/", "/index.html", "assets/index-a.js", page)).toEqual(named({
      glsl: "/app/assets/babylon-shaders-glsl-e.js",
      wgsl: "/app/assets/babylon-shaders-wgsl-f.js",
    }));
    expect(transformPage("https://cdn.example/site", "/index.html", "assets/index-a.js", page)).toEqual(named({
      glsl: "https://cdn.example/site/assets/babylon-shaders-glsl-e.js",
      wgsl: "https://cdn.example/site/assets/babylon-shaders-wgsl-f.js",
    }));
  });

  it("names them relative to the page under a relative base", () => {
    expect(transformPage("./", "/index.html", "assets/index-a.js", page)).toEqual(named({
      glsl: "./assets/babylon-shaders-glsl-e.js",
      wgsl: "./assets/babylon-shaders-wgsl-f.js",
    }));
    expect(transformPage("", "/tour/minneapolis/index.html", "assets/index-a.js", page)).toEqual(named({
      glsl: "../../assets/babylon-shaders-glsl-e.js",
      wgsl: "../../assets/babylon-shaders-wgsl-f.js",
    }));
  });

  it("adds nothing to a page whose code cannot reach them, or in the dev server", () => {
    const about = [chunk("assets/about-a.js", "about", ["assets/vendor-b.js"]), ...page];
    expect(transformPage("/", "/about.html", "assets/about-a.js", about)).toBeUndefined();
    const plugin = babylonShaderChunks();
    const serve = { path: "/index.html", filename: "/site/index.html" } as IndexHtmlTransformContext;
    expect((plugin.transformIndexHtml as (html: string, ctx: IndexHtmlTransformContext) => unknown)("<html></html>", serve)).toBeUndefined();
  });

  it("names only the language a page can reach", () => {
    const webgl = [chunk("assets/index-a.js", "index", [], ["assets/babylon-shaders-glsl-e.js"]), ...page.slice(4)];
    expect(transformPage("/", "/index.html", "assets/index-a.js", webgl)).toEqual(named({ glsl: "/assets/babylon-shaders-glsl-e.js" }));
  });

  it("escapes markup in the names", () => {
    const odd = [chunk("assets/index-a.js", "index", [], ["assets/</script>.js"]), chunk("assets/</script>.js", "babylon-shaders-glsl")];
    const [script] = transformPage("/", "/index.html", "assets/index-a.js", odd) as Array<{ children: string }>;
    expect(script.children).not.toContain("</script>");
    expect(JSON.parse(script.children)).toEqual({ glsl: "/assets/</script>.js" });
  });
});
