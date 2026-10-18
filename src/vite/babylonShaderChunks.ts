/**
 * Babylon's shaders, in one chunk for each language, which a page fetches only for the language its renderer
 * draws with (optimization backlog S4). Babylon's materials import their shaders with import() for the
 * language they compile, so each language's chunk holds the shaders imported that way, and loads when the
 * first of them is needed. Two kinds of module stay out of it:
 *
 * - the shader store the shaders register in, which gets a chunk of its own: the code that compiles shaders
 *   imports it too, and with the store inside a language's chunk, that code would load the language;
 * - the shaders that code outside the shader folders imports statically, such as the WebGPU engine's clear quad,
 *   which load with that code, and share one chunk: other shaders import some of them too, and each would
 *   otherwise get a chunk of its own.
 *
 * The page names both chunks in a JSON script, from which the renderer preloads the language it draws with as
 * soon as it knows it (src/babylon/browserRenderer.ts). A page that can reach the WGSL chunk can draw with WebGPU,
 * and asks for its adapter first thing, while its modules load (src/earlyWebGpuSupport.ts).
 */
import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin, Rolldown } from "vite";
import { EARLY_WEBGPU_SUPPORT_GLOBAL } from "../earlyWebGpuSupport.js";
import { RENDERER_FALLBACK_STORAGE_KEY } from "../rendererPreference.js";
import { SHADER_CHUNKS_ELEMENT_ID, type ShaderChunkLanguage } from "../shaderChunks.js";
import { BABYLON_BARREL } from "./babylonBarrels.js";

const SHADER = /[\\/]@babylonjs[\\/]core[\\/]Shaders(?:WGSL)?[\\/]/;
const CHUNKS: Record<string, ShaderChunkLanguage> = { "babylon-shaders-glsl": "glsl", "babylon-shaders-wgsl": "wgsl" };

/**
 * Whether code outside the shader folders imports this shader statically, directly or through other shaders.
 * Babylon's index files do not count. With `babylonBarrels()` the build leaves them out; without it they import
 * every shader, and each language's chunk then loads with Babylon, as before this split.
 * A module the build leaves out still counts, which can only move a shader to the chunk that loads with Babylon.
 */
function importedStatically(id: string, graph: Rolldown.ChunkingContext, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  return (graph.getModuleInfo(id)?.importers ?? []).some(importer =>
    !BABYLON_BARREL.test(importer) && (!SHADER.test(importer) || importedStatically(importer, graph, seen)));
}

function shaders(name: string, test: RegExp, statically: boolean): Rolldown.CodeSplittingGroup {
  return {
    name: (id, graph) => (importedStatically(id, graph) === statically ? name : null),
    debugName: name,
    test,
    // A shader's imports are the store and other shaders, each of which has its own place.
    includeDependenciesRecursively: false,
  };
}

/** The groups, by module path, for a host that supplies its own codeSplitting groups. */
export const BABYLON_SHADER_GROUPS: Rolldown.CodeSplittingGroup[] = [
  { name: "babylon-shader-store", test: /[\\/]@babylonjs[\\/]core[\\/]Engines[\\/]shaderStore\.js$/ },
  shaders("babylon-shaders-static", SHADER, true),
  shaders("babylon-shaders-glsl", /[\\/]@babylonjs[\\/]core[\\/]Shaders[\\/]/, false),
  shaders("babylon-shaders-wgsl", /[\\/]@babylonjs[\\/]core[\\/]ShadersWGSL[\\/]/, false),
];

/** A page's base for its files, as Vite writes it into the page: absolute, or relative to the page. */
function pageBase(base: string, pagePath: string): string {
  if (/^(?:[a-z][\w+.-]*:)?\//i.test(base)) return base.endsWith("/") ? base : `${base}/`;
  const depth = pagePath.split("/").filter(Boolean).length - 1;
  return "../".repeat(depth) || "./";
}

/** Each language's chunk that the page's code can load, by static or dynamic import. */
function shaderChunks(ctx: IndexHtmlTransformContext): Partial<Record<ShaderChunkLanguage, string>> {
  const found: Partial<Record<ShaderChunkLanguage, string>> = {};
  if (!ctx.bundle || !ctx.chunk) return found;
  const seen = new Set<string>();
  const queue = [ctx.chunk.fileName];
  while (queue.length) {
    const output: Rolldown.OutputChunk | Rolldown.OutputAsset | undefined = ctx.bundle[queue.shift()!];
    if (output?.type !== "chunk" || seen.has(output.fileName)) continue;
    seen.add(output.fileName);
    const shaders = CHUNKS[output.name];
    if (shaders) found[shaders] = output.fileName;
    queue.push(...output.imports, ...output.dynamicImports);
  }
  return found;
}

/**
 * Asks for a WebGPU adapter, unless WebGL is saved as this browser's fallback, and keeps whether one came for the
 * renderer. It runs in every browser, so it is written for the oldest, and defines no names of its own.
 */
const EARLY_WEBGPU_SUPPORT_SCRIPT = `try{if(navigator.gpu&&!localStorage.getItem(${JSON.stringify(RENDERER_FALLBACK_STORAGE_KEY)}))`
  + `window.${EARLY_WEBGPU_SUPPORT_GLOBAL}=navigator.gpu.requestAdapter().then(function(adapter){return!!adapter},function(){return!1})}catch(error){}`;

/** The page with the early adapter request as its first script, right after <meta charset>, which must stay within the first 1024 bytes. */
function withEarlyWebGpuSupport(html: string, tags: HtmlTagDescriptor[]): { html: string; tags: HtmlTagDescriptor[] } {
  const charset = html.match(/<meta\s+charset=[^>]*>/i);
  if (!charset) return { html, tags: [{ tag: "script", children: EARLY_WEBGPU_SUPPORT_SCRIPT, injectTo: "head-prepend" }, ...tags] };
  const at = charset.index! + charset[0].length;
  return { html: `${html.slice(0, at)}<script>${EARLY_WEBGPU_SUPPORT_SCRIPT}</script>${html.slice(at)}`, tags };
}

export function babylonShaderChunks(): Plugin {
  let base = "/";
  return {
    name: "foss-earth-babylon-shader-chunks",
    config: () => ({ build: { rolldownOptions: { output: { codeSplitting: { groups: BABYLON_SHADER_GROUPS } } } } }),
    configResolved(config) { base = config.base; },
    transformIndexHtml(html, ctx) {
      const chunks = shaderChunks(ctx);
      if (!chunks.glsl && !chunks.wgsl) return;
      const prefix = pageBase(base, ctx.path);
      const urls = Object.fromEntries(Object.entries(chunks).map(([key, fileName]) => [key, prefix + fileName]));
      const tags: HtmlTagDescriptor[] = [{ tag: "script", attrs: { type: "application/json", id: SHADER_CHUNKS_ELEMENT_ID }, children: JSON.stringify(urls).replace(/</g, "\\u003c"), injectTo: "head" }];
      return chunks.wgsl ? withEarlyWebGpuSupport(html, tags) : tags;
    },
  };
}
