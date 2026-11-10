import { Constants, RawTexture, RawTexture2DArray, type AbstractEngine, type Engine, type ThinEngine, type InternalTexture, type Scene, type Texture } from "@babylonjs/core";
import type { TextureTransferOutcome, TextureTransferRetirement, TryAdmitTextureTransfer } from "../textureTransferTypes.js";
import type { UploadTicket } from "./imageUploadTypes.js";
import { withTextureUploadState } from "./textureUploadState.js";
import { protectTextureDisposal } from "./textureDisposal.js";

export interface RawTextureRequest {
  scene: Scene; data: Uint8Array | null; width: number; height: number; depth?: number;
  format: number; mipmaps: boolean; invertY: boolean; samplingMode: number; type: number;
}
export interface TextureDevicePorts {
  createRawTexture(options: RawTextureRequest): Texture;
  updateTextureData(texture: InternalTexture, data: ArrayBufferView, x: number, y: number,
    width: number, height: number, faceIndex?: number, lod?: number, generateMipMaps?: boolean): void;
}
/** RGBA8 region/mip order is supplied entirely by the feature owner. */
export interface RawTextureBatchRegion {
  readonly texture: InternalTexture;
  readonly data: Uint8Array;
  readonly x: number; readonly y: number;
  readonly width: number; readonly height: number;
  readonly faceIndex?: number; readonly lod?: number;
  readonly generateMipMaps?: boolean;
}
export interface RawTextureBatchRequest {
  readonly regions: readonly RawTextureBatchRegion[];
  readonly label: string;
  /** Hold the producer's pages through proven native retirement. */
  retainInput(): () => void;
  /** Same broker: admit private decoded/staging snapshot bytes before allocation. */
  reserveCopy(bytes: number, label: string): UploadTicket;
}
export interface PreparedRawTextureBatch {
  readonly bytes: number;
  readonly active: boolean;
  readonly settled: Promise<TextureTransferOutcome>;
  readonly retired: Promise<TextureTransferRetirement>;
  submit(): void;
  cancel(reason?: unknown): void;
}
/** Additive capability; legacy structural raw device ports remain unchanged. */
export interface RawTextureBatchDevicePorts extends TextureDevicePorts {
  prepareRawTextureBatch(request: RawTextureBatchRequest): PreparedRawTextureBatch | null;
}
/**
 * Borrow the already selected backend. The host transfer port admits bytes
 * before submission and retains its grant until device completion. Layout,
 * residency, mip contents and material parameters stay in the feature owner.
 */
export function createTextureDevicePorts(options: {
  scene: Scene;
  transfer<T>(bytes: number, label: string, submit: () => T): T;
  tryAdmit?: TryAdmitTextureTransfer;
}): RawTextureBatchDevicePorts {
  const engine = options.scene.getEngine();
  const nativeUpdate = (engine as AbstractEngine & Partial<Pick<ThinEngine, "updateTextureData">>).updateTextureData;
  if (typeof nativeUpdate !== "function") throw new Error("The borrowed renderer does not support raw texture region updates.");
  const updateTextureData = nativeUpdate.bind(engine);
  const uploadTarget = (texture: InternalTexture): "2d" | "cube" | "2d-array" =>
    texture.isCube ? "cube" : texture.is2DArray ? "2d-array" : "2d";
  const performUpdate = (texture: InternalTexture, data: ArrayBufferView, x: number, y: number,
    width: number, height: number, faceIndex: number, lod: number, generateMipMaps: boolean): void => {
    const borrowed = engine as Engine;
    const gl = borrowed._gl as WebGL2RenderingContext | undefined;
    if (texture.is2DArray && gl && typeof gl.texSubImage3D === "function" && borrowed.webGLVersion >= 2) {
      const textureType = borrowed._getWebGLTextureType(texture.type);
      const format = borrowed._getInternalFormat(texture.format);
      borrowed._unpackFlipY(texture.invertY);
      borrowed._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, texture, true);
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, lod, x, y, faceIndex, width, height, 1, format, textureType, data);
      if (generateMipMaps) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      borrowed._bindTextureDirectly(gl.TEXTURE_2D_ARRAY, null);
      return;
    }
    updateTextureData(texture, data, x, y, width, height, faceIndex, lod, generateMipMaps);
  };
  const dimensions = (width: number, height: number, depth = 1): void => {
    const caps = engine.getCaps() as { maxTextureSize: number; texture2DArrayMaxLayerCount?: number };
    const maxLayers = caps.texture2DArrayMaxLayerCount || 256;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(depth) || width < 1 || height < 1 || depth < 1 || width > caps.maxTextureSize || height > caps.maxTextureSize || (depth > 1 && depth > maxLayers)) {
      throw new Error("Texture dimensions exceed the borrowed renderer's limits.");
    }
  };
  type Region = Required<RawTextureBatchRegion>;
  const validateRegion = (region: Region): void => {
    const { texture, data, x, y, width, height, faceIndex, lod, generateMipMaps } = region;
    if (texture.getEngine() !== engine) throw new Error("Texture belongs to a different renderer device.");
    dimensions(width, height);
    if (![x, y, faceIndex, lod].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Texture update origin/layer/mip must be nonnegative integers.");
    if (!(data instanceof Uint8Array) || data.byteLength !== width * height * 4) throw new Error("A raw texture batch region needs exactly width * height * 4 RGBA8 bytes.");
    if (texture.format !== Constants.TEXTUREFORMAT_RGBA || texture.type !== Constants.TEXTURETYPE_UNSIGNED_BYTE) throw new Error("Raw texture batches require RGBA8 texture storage.");
    if (!Number.isSafeInteger(texture.width) || !Number.isSafeInteger(texture.height) || texture.width < 1 || texture.height < 1) throw new Error("Raw texture batch storage dimensions are unavailable.");
    if (lod > Math.floor(Math.log2(Math.max(texture.width, texture.height)))) throw new Error("Raw texture batch mip exceeds its texture storage.");
    const mipWidth = Math.max(1, Math.floor(texture.width / 2 ** lod));
    const mipHeight = Math.max(1, Math.floor(texture.height / 2 ** lod));
    const maxFaceIndex = texture.isCube ? 5 : texture.is2DArray ? Math.max(0, (texture.depth || 1) - 1) : 0;
    if (x + width > mipWidth || y + height > mipHeight || faceIndex > maxFaceIndex) throw new Error("Raw texture batch region exceeds its texture storage.");
    if (typeof generateMipMaps !== "boolean") throw new Error("Raw texture batch mip-generation policy must be a boolean.");
  };
  return {
    prepareRawTextureBatch(request) {
      if (!options.tryAdmit) throw new Error("Completion-aware raw texture batches require an explicit admission port.");
      if (!request.regions.length) throw new Error("A raw texture batch needs at least one region.");
      const label = request.label;
      if (typeof label !== "string" || !label) throw new Error("A raw texture batch needs a nonempty host label.");
      // Snapshot metadata before supplied admission callbacks can mutate it.
      const regions: Region[] = request.regions.map(region => ({
        texture: region.texture, data: region.data, x: region.x, y: region.y,
        width: region.width, height: region.height, faceIndex: region.faceIndex ?? 0,
        lod: region.lod ?? 0, generateMipMaps: region.generateMipMaps ?? false,
      }));
      let bytes = 0;
      for (const region of regions) {
        validateRegion(region); bytes += region.data.byteLength;
        if (!Number.isSafeInteger(bytes)) throw new Error("Raw texture batch bytes exceed the exact integer range.");
      }
      const snapshots: Region[] = [];
      const admission = options.tryAdmit(bytes, label, () => {
        const releaseInput = request.retainInput();
        if (typeof releaseInput !== "function") throw new Error("Raw texture batch retention must return a release function.");
        let copyTicket: UploadTicket;
        try {
          copyTicket = request.reserveCopy(bytes, `${label} immutable RGBA8 snapshots`);
          if (!copyTicket || typeof copyTicket.release !== "function") throw new Error("Raw texture batch copy admission did not return a grant.");
        }
        catch (error) {
          try { releaseInput(); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], "Raw texture batch copy admission cleanup failed."); }
          throw error;
        }
        return () => {
          // Drop our private references before returning their copy-memory grant.
          snapshots.length = 0;
          const errors: unknown[] = [];
          try { copyTicket.release(); } catch (error) { errors.push(error); }
          try { releaseInput(); } catch (error) { errors.push(error); }
          if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Raw texture batch input cleanup failed.");
        };
      });
      if (!admission) return null;
      try {
        if (admission.active) for (const region of regions) snapshots.push(Object.freeze({ ...region, data: new Uint8Array(region.data) }));
      } catch (error) { admission.cancel(error); throw error; }
      // Original mutable views are never referenced by the native submission.
      regions.length = 0;
      return {
        bytes, settled: admission.settled, retired: admission.retired,
        get active() { return admission.active && snapshots.length > 0; },
        submit() {
          admission.submit(isActive => {
            for (const region of snapshots) {
              if (!isActive()) return;
              validateRegion(region);
              withTextureUploadState(engine, () => performUpdate(region.texture, region.data, region.x, region.y, region.width, region.height, region.faceIndex, region.lod, region.generateMipMaps), uploadTarget(region.texture));
            }
          });
        },
        cancel(reason) { admission.cancel(reason); },
      };
    },
    createRawTexture(request) {
      if (request.scene !== options.scene) throw new Error("Texture belongs to a different renderer scene.");
      const depth = request.depth ?? 1;
      dimensions(request.width, request.height, depth);
      const allocation: { texture: Texture | null } = { texture: null };
      const target = depth > 1 ? "2d-array" : "2d";
      const create = (): Texture => withTextureUploadState(engine, () => {
        let texture: Texture;
        if (depth > 1) {
          const borrowed = engine as Engine & { _gl?: WebGL2RenderingContext; createRawTexture2DArray?: (...args: unknown[]) => InternalTexture };
          if (!borrowed.isWebGPU && (!borrowed._gl || typeof borrowed.createRawTexture2DArray !== "function")) {
            texture = new RawTexture(request.data, request.width, request.height, request.format, request.scene, request.mipmaps, request.invertY, request.samplingMode, request.type);
            const internal = texture.getInternalTexture();
            if (internal) {
              internal.depth = internal.baseDepth = depth;
              internal.is2DArray = true;
            }
          } else {
            texture = new RawTexture2DArray(request.data, request.width, request.height, depth, request.format, request.scene, request.mipmaps, request.invertY, request.samplingMode, request.type);
          }
        } else {
          texture = new RawTexture(request.data, request.width, request.height, request.format, request.scene, request.mipmaps, request.invertY, request.samplingMode, request.type);
        }
        allocation.texture = texture;
        protectTextureDisposal(texture);
        return texture;
      }, target);
      try {
        const allocate = (): Texture => { allocation.texture = create(); return allocation.texture; };
        return request.data ? options.transfer(request.data.byteLength, "raw texture allocation", allocate) : allocate();
      } catch (error) {
        // Transfer completion tracking can throw after native allocation succeeded.
        // The caller received no texture and cannot own that allocation.
        try { allocation.texture?.dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Raw texture allocation cleanup failed."); }
        throw error;
      }
    },
    updateTextureData(texture, data, x, y, width, height, faceIndex = 0, lod = 0, generateMipMaps = false) {
      if (texture.getEngine() !== engine) throw new Error("Texture belongs to a different renderer device.");
      dimensions(width, height);
      if (![x, y, faceIndex, lod].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Texture update origin/layer/mip must be nonnegative integers.");
      options.transfer(data.byteLength, "raw texture update", () => withTextureUploadState(engine, () => performUpdate(texture, data, x, y, width, height, faceIndex, lod, generateMipMaps), uploadTarget(texture)));
    },
  };
}
