import { BaseTexture, Constants, InternalTexture, InternalTextureSource, type Engine, type Scene, type WebGPUEngine } from "@babylonjs/core";
import type { UploadTicket } from "./imageUploadTypes.js";
import { isBorrowedWebGpuEngine } from "./imageTextureUpload.js";
import { withTextureUploadState } from "./textureUploadState.js";
import { protectTextureDisposal } from "./textureDisposal.js";

export interface ImageRegionTextureRequest {
  width: number; height: number; label: string; samplingMode: number;
  /** sRGB input is decoded by the GPU format, or by the feature's GL shader. */
  srgb: boolean;
}
export interface ImageRegionDevicePorts {
  createTexture(request: ImageRegionTextureRequest): BaseTexture;
  /** Takes ownership of the grant even if submission partially succeeds and throws. */
  copyImage(texture: BaseTexture, image: ImageBitmap, x: number, y: number, ticket: UploadTicket): void;
  copyBytes(texture: BaseTexture, bytes: Uint8Array, ticket: UploadTicket): void;
}
interface GpuInternals {
  _device: { queue: { copyExternalImageToTexture(source: unknown, destination: unknown, size: unknown): void } };
  _textureHelper: { createGPUTextureForInternalTexture(texture: InternalTexture, width: number, height: number, depth: number, flags: number): unknown };
}
/** Generic mutable 2D textures, on the host's already selected scene/device. */
export function createImageRegionDevicePorts(options: {
  scene: Scene;
  track<T>(ticket: UploadTicket, submit: () => T): T;
}): ImageRegionDevicePorts {
  const { scene } = options;
  const engine = scene.getEngine();
  const gpu = isBorrowedWebGpuEngine(engine);
  const internals = new WeakMap<BaseTexture, { texture: InternalTexture; width: number; height: number }>();
  const dimensions = (width: number, height: number): void => {
    const maximum = engine.getCaps().maxTextureSize;
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= maximum)) throw new Error("Texture dimensions exceed the borrowed renderer's limits.");
  };
  const owned = (texture: BaseTexture) => {
    const entry = internals.get(texture);
    if (!entry || texture.getInternalTexture() !== entry.texture) throw new Error("Texture belongs to another renderer adapter or has been disposed.");
    return entry;
  };
  return {
    createTexture(request) {
      dimensions(request.width, request.height);
      let internal: InternalTexture | null = null;
      const allocation: { internal: InternalTexture | null } = { internal: null };
      let texture: BaseTexture | null = null;
      try {
        if (gpu) {
          const borrowed = engine as unknown as WebGPUEngine & GpuInternals;
          internal = new InternalTexture(borrowed, InternalTextureSource.Unknown);
          internal.format = Constants.TEXTUREFORMAT_RGBA;
          internal.type = Constants.TEXTURETYPE_UNSIGNED_BYTE;
          internal._useSRGBBuffer = request.srgb;
          internal.generateMipMaps = false;
          internal.samplingMode = request.samplingMode;
          internal.label = request.label;
          internal.invertY = false;
          borrowed._textureHelper.createGPUTextureForInternalTexture(internal, request.width, request.height, 1, 0);
        } else {
          internal = withTextureUploadState(engine, () => {
            allocation.internal = (engine as Engine).createRawTexture(null, request.width, request.height, Constants.TEXTUREFORMAT_RGBA, false, false, request.samplingMode);
            return allocation.internal;
          });
          internal.label = request.label;
        }
        internal.isReady = true;
        texture = new BaseTexture(scene, internal);
        protectTextureDisposal(texture);
        texture.name = request.label;
        texture.gammaSpace = !(gpu && request.srgb);
        internals.set(texture, { texture: internal, width: request.width, height: request.height });
        return texture;
      } catch (error) {
        if (texture) texture.dispose(); else (internal ?? allocation.internal)?.dispose();
        throw error;
      }
    },
    copyImage(texture, image, x, y, ticket) {
      // Invalid input has not submitted anything, so its grant can be released immediately.
      let target: ReturnType<typeof owned>;
      try {
        target = owned(texture);
        if (![x, y].every(value => Number.isSafeInteger(value) && value >= 0) || ![image.width, image.height].every(value => Number.isSafeInteger(value) && value > 0) || x + image.width > target.width || y + image.height > target.height) throw new Error("Image copy lies outside the texture.");
      } catch (error) { ticket.release(); throw error; }
      options.track(ticket, () => {
        if (gpu) {
          const borrowed = engine as unknown as GpuInternals;
          const resource = (target.texture._hardwareTexture as unknown as { underlyingResource: unknown }).underlyingResource;
          borrowed._device.queue.copyExternalImageToTexture({ source: image, flipY: false }, { texture: resource, mipLevel: 0, origin: { x, y, z: 0 }, colorSpace: "srgb", premultipliedAlpha: false }, { width: image.width, height: image.height, depthOrArrayLayers: 1 });
        } else {
          const borrowed = engine as Engine;
          const gl = borrowed._gl;
          const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
          const conversion = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) as number;
          const flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
          borrowed._bindTextureDirectly(gl.TEXTURE_2D, target.texture, true);
          try {
            borrowed._unpackFlipY(false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, image);
          } finally {
            try { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply); }
            finally {
              try { gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, conversion); }
              finally { try { borrowed._unpackFlipY(flipY); } finally { borrowed._bindTextureDirectly(gl.TEXTURE_2D, null, true); } }
            }
          }
        }
      });
    },
    copyBytes(texture, bytes, ticket) {
      let target: ReturnType<typeof owned>;
      try { target = owned(texture); if (bytes.byteLength !== target.width * target.height * 4) throw new Error("RGBA texture data dimensions do not match."); }
      catch (error) { ticket.release(); throw error; }
      options.track(ticket, () => withTextureUploadState(engine, () => engine.updateRawTexture(target.texture, bytes, Constants.TEXTUREFORMAT_RGBA, false)));
    },
  };
}
