import type { GoogleCore } from "../google-TS/index.js";

export type { GoogleCore, GooglePrimitive, GoogleTileResult } from "../google-TS/index.js";
export function loadGoogleCore(options?: { wasmUrl?: URL | string; fetch?: typeof fetch }): Promise<GoogleCore>;
export function instantiateGoogleCore(bytes: BufferSource | WebAssembly.Module): Promise<GoogleCore>;
export function createGoogleCore(exports: WebAssembly.Exports): GoogleCore;
