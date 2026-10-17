/** A language Babylon's shaders are written in: GLSL for WebGL, WGSL for WebGPU. */
export type ShaderChunkLanguage = "glsl" | "wgsl";

/**
 * The id of the `<script type="application/json">` in which `babylonShaderChunks()` names a built page's chunk
 * of Babylon shaders for each language, as `{ "glsl": url, "wgsl": url }`. The renderer preloads the one it
 * draws with from it.
 */
export const SHADER_CHUNKS_ELEMENT_ID = "babylon-shader-chunks";
