import { DynamicTexture, type Scene } from "@babylonjs/core";
import { disposeTextureResource, protectTextureDisposal } from "./textureDisposal.js";
import { withTextureUploadState } from "./textureUploadState.js";

export interface CanvasTextureRequest { name: string; width: number; height: number; mipmaps: boolean; samplingMode?: number }
export interface CanvasTextureDevicePorts {
  createTexture(request: CanvasTextureRequest): DynamicTexture;
  updateTexture(texture: DynamicTexture, flipY: boolean): void;
}

/** Pixel drawing belongs to the feature; canvas realm and backend transfers are explicit. */
export function createCanvasTextureDevicePorts(options: {
  scene: Scene;
  createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas;
  transfer<T>(bytes: number, label: string, submit: () => T): T;
}): CanvasTextureDevicePorts {
  const engine = options.scene.getEngine();
  const owned = new WeakMap<DynamicTexture, HTMLCanvasElement | OffscreenCanvas>();
  const dimensions = (width: number, height: number): void => {
    const maximum = engine.getCaps().maxTextureSize;
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= maximum)) throw new Error("Canvas texture dimensions exceed the borrowed renderer's limits.");
  };
  return {
    createTexture(request) {
      dimensions(request.width, request.height);
      // Supply the realm before Babylon can allocate a fallback canvas.
      const canvas = options.createCanvas(request.width, request.height);
      canvas.width = request.width; canvas.height = request.height;
      const allocation: { texture: DynamicTexture | null } = { texture: null };
      try {
        const texture = withTextureUploadState(engine, () => {
          allocation.texture = new DynamicTexture(request.name, canvas, options.scene, request.mipmaps, request.samplingMode);
          return allocation.texture;
        });
        protectTextureDisposal(texture);
        owned.set(texture, canvas);
        return texture;
      } catch (error) {
        try { if (allocation.texture) disposeTextureResource(allocation.texture); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], "Canvas texture allocation cleanup failed."); }
        throw error;
      }
    },
    updateTexture(texture, flipY) {
      const canvas = owned.get(texture), internal = texture.getInternalTexture();
      if (!canvas || texture.getScene() !== options.scene || !internal || internal.getEngine() !== engine) throw new Error("Canvas texture belongs to another renderer adapter or has been disposed.");
      dimensions(canvas.width, canvas.height);
      options.transfer(canvas.width * canvas.height * 4, `${texture.name} canvas texture update`, () => withTextureUploadState(engine, () => texture.update(flipY)));
    },
  };
}
