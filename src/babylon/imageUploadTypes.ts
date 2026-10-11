import type { BaseTexture, Scene } from "@babylonjs/core";

/** Generic device texture; source conventions belong to the representation. */
export interface UploadedImageTexture {
  readonly kind: "cube" | "2d";
  readonly width: number;
  readonly height: number;
  readonly levels: number;
  readonly gpuBytes: number;
  readonly texture: BaseTexture;
  readonly complete: boolean;
  dispose(): void;
}
export interface UploadTicket { release(): void }
export interface ImageUploadRequest {
  kind: "cube" | "2d";
  /** Cube images are already ordered by the representation's GPU convention. */
  images: readonly ImageBitmap[];
  label: string;
  /** Explicit storage/material flags; omitted retains each backend's existing 360 defaults. */
  textureColor?: { useSRGBBuffer: boolean; gammaSpace: boolean };
  signal: AbortSignal;
  /** Grant from the host's ONE image broker before any staging submission. */
  reserveUpload(bytes: number, label: string): UploadTicket;
  /** WebGL's cropped strip canvas consumes decoded/staging memory too. */
  reserveDecodedStaging(bytes: number, label: string): UploadTicket;
}
export interface ImageUploadLimits { bytesPerFrame: number; outstandingBytes: number }
/** A rejected native completion after the texture was transferred to its caller. */
export interface ImageUploadCompletionFailure {
  readonly error: unknown;
  readonly label: string;
  readonly texture: UploadedImageTexture;
  /** Present when the host invalidation callback threw/rejected; renderer retains one latest record. */
  readonly invalidationError?: unknown;
}
export interface ImageUploadStats {
  queuedJobs: number; outstandingBytes: number; lastFrameBytes: number; uploadedBytes: number;
  publishedCompletionFailures: number;
  lastPublishedCompletionFailure: ImageUploadCompletionFailure | null;
}
export interface ImageTextureUploader {
  upload(request: ImageUploadRequest): Promise<UploadedImageTexture>;
  /** Host calls once per frame; no private scheduler or timer. */
  pump(): number;
  busy(): boolean;
  setLimits(limits: ImageUploadLimits): void;
  stats(): ImageUploadStats;
  /** Pending submitted work retains tickets until completion, unless deviceLost. */
  cancelAll(reason: string, options?: { deviceLost?: boolean }): void;
}
/** Additive factory contract; legacy structural uploader doubles remain valid. */
export interface SettledImageTextureUploader extends ImageTextureUploader {
  /** Includes submitted native copies and asynchronous host invalidation callbacks. */
  whenSettled(): Promise<void>;
}
export type UploadCanvas = OffscreenCanvas | HTMLCanvasElement;
export interface ImageTextureUploaderOptions {
  scene: Scene;
  limits: ImageUploadLimits;
  requestRender(): void;
  /**
   * Host invalidates its source/cache/presentation generation after a rejected
   * completion for transferred ownership. Renderer never disposes that texture.
   * This is not confirmation of device loss. Throwing/rejected callbacks are
   * caught and exposed in stats; host applies its existing fatal policy. Perform
   * generation retirement synchronously before any optional asynchronous cleanup.
   */
  invalidatePublishedSource(failure: ImageUploadCompletionFailure): void | Promise<void>;
  /** Required only by WebGL strip uploads. No implicit document/global lookup. */
  createStagingCanvas(width: number, height: number): UploadCanvas;
}
export function validateUploadLimits(limits: ImageUploadLimits): void {
  if (![limits.bytesPerFrame, limits.outstandingBytes].every(value => Number.isFinite(value) && value > 0)) throw new Error("Upload limits must be positive finite byte counts.");
}
export function validateUploadRequest(request: ImageUploadRequest, maxTextureSize: number): void {
  request.signal.throwIfAborted();
  if (request.kind !== "2d" && request.kind !== "cube") throw new Error("Texture upload kind must be 2d or cube.");
  if (!Number.isSafeInteger(maxTextureSize) || maxTextureSize < 1) throw new Error("The borrowed renderer did not supply a valid texture-size limit.");
  if (request.images.length !== (request.kind === "cube" ? 6 : 1)) throw new Error("A texture upload needs one image or six cube layers.");
  const first = request.images[0];
  if (!request.images.every(image => Number.isSafeInteger(image.width) && image.width > 0 && Number.isSafeInteger(image.height) && image.height > 0 && image.width === first.width && image.height === first.height) || (request.kind === "cube" && first.width !== first.height)) throw new Error("Texture layers must have matching positive dimensions; cube layers must be square.");
  if (first.width > maxTextureSize || first.height > maxTextureSize) throw new Error("Texture dimensions exceed the borrowed renderer's limits.");
  if (request.textureColor && (typeof request.textureColor.useSRGBBuffer !== "boolean" || typeof request.textureColor.gammaSpace !== "boolean")) throw new Error("Texture storage/material color flags must be booleans.");
}
export function textureMipCount(width: number, height: number): number { return 1 + Math.floor(Math.log2(Math.max(width, height))); }
export function textureRgbaBytes(width: number, height: number, levels: number, layers: number): number {
  let bytes = 0;
  for (let level = 0; level < levels; level++) { bytes += width * height * 4 * layers; width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2)); }
  return bytes;
}
