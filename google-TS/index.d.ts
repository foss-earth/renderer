export interface GooglePrimitive {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  sourceIndexComponentType: 5121 | 5123;
  materialIndex: number;
  jpeg: Uint8Array;
  sampler?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number };
}
export type GoogleTileResult = { supported: false; reason: string } | {
  supported: true;
  actualTier: "single" | "typescript";
  validationStatus: "unvalidated";
  metadata: Record<string, unknown>;
  matrix: Float64Array;
  nodeName?: string;
  meshName?: string;
  primitives: GooglePrimitive[];
};
export interface GoogleCore {
  readonly actualTier: "single" | "typescript";
  readonly validationStatus: "unvalidated";
  decodeGlb(data: ArrayBuffer | Uint8Array): GoogleTileResult;
}

/** Retained byte-exact reference for an equal-worker comparison. */
export function createTypeScriptGoogleCore(): GoogleCore;
