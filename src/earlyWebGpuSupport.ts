/**
 * The window property in which a built page keeps the WebGPU adapter request it makes while it parses, as a
 * promise of whether there is an adapter (`babylonShaderChunks()` in ./vite). A browser's first adapter takes
 * some tens of milliseconds to come and the next ones little, so it comes while the page's modules load. The
 * browser host takes it, once, in place of `WebGPUEngine.IsSupportedAsync`, which asks the same.
 */
export const EARLY_WEBGPU_SUPPORT_GLOBAL = "__fossEarthWebGpuSupport";
