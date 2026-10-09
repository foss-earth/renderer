/** Generic row uploads extracted from panoramaTextures; supplied scene only. */
import { BaseTexture, Constants, InternalTexture, InternalTextureSource, type Scene, type WebGPUEngine } from "@babylonjs/core";
import { createWebGlImageTextureUploader } from "./imageTextureUploadWebGl.js";
import { disposeTextureResource } from "./textureDisposal.js";
import { textureMipCount, textureRgbaBytes, validateUploadLimits, validateUploadRequest, type ImageTextureUploader, type ImageTextureUploaderOptions, type ImageUploadRequest, type ImageUploadCompletionFailure, type UploadedImageTexture, type UploadTicket } from "./imageUploadTypes.js";

/** Babylon's device is borrowed; this adapter never initializes one. */
interface WebGpuInternals {
  _device: { queue: { copyExternalImageToTexture(source: unknown, destination: unknown, size: unknown): void; onSubmittedWorkDone(): Promise<void> } };
  _textureHelper: {
    createGPUTextureForInternalTexture(texture: InternalTexture, width?: number, height?: number, depth?: number, flags?: number): unknown;
    generateCubeMipmaps(texture: unknown, levels: number): void;
    generateMipmaps(texture: unknown, levels: number, face?: number): void;
  };
}
export function isBorrowedWebGpuEngine(engine: unknown): engine is WebGPUEngine {
  return Boolean(engine && (engine as { isWebGPU?: boolean }).isWebGPU && (engine as Partial<WebGpuInternals>)._device);
}
function allocate(scene: Scene, request: ImageUploadRequest) {
  const engine = scene.getEngine() as unknown as WebGPUEngine & WebGpuInternals;
  const { kind, label } = request;
  const { width, height } = request.images[0];
  const internal = new InternalTexture(engine, InternalTextureSource.Unknown);
  internal.isCube = kind === "cube";
  internal.format = Constants.TEXTUREFORMAT_RGBA;
  internal.type = Constants.TEXTURETYPE_UNSIGNED_BYTE;
  internal._useSRGBBuffer = request.textureColor?.useSRGBBuffer ?? true;
  internal.generateMipMaps = true;
  internal.samplingMode = Constants.TEXTURE_TRILINEAR_SAMPLINGMODE;
  internal.label = label;
  internal.invertY = false;
  let allocated: BaseTexture | null = null;
  let hardware: { underlyingResource: unknown };
  let gpuTexture: unknown;
  try {
    engine._textureHelper.createGPUTextureForInternalTexture(internal, width, height, 1, 0);
    allocated = new BaseTexture(scene, internal);
    allocated.name = label;
    allocated.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    allocated.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    allocated.gammaSpace = request.textureColor?.gammaSpace ?? false;
    hardware = internal._hardwareTexture as unknown as { underlyingResource: unknown };
    gpuTexture = hardware.underlyingResource;
  } catch (error) {
    try { if (allocated) disposeTextureResource(allocated); else internal.dispose(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Image texture allocation cleanup failed."); }
    throw error;
  }
  const texture = allocated;
  const levels = textureMipCount(width, height);
  let complete = false;
  let disposed = false;
  return {
    kind, width, height, levels, texture, hardware,
    gpuTexture,
    gpuBytes: textureRgbaBytes(width, height, levels, kind === "cube" ? 6 : 1),
    get complete() { return complete; },
    get disposed() { return disposed; },
    markComplete() { internal.isReady = true; complete = true; },
    dispose() { if (disposed) return; disposed = true; disposeTextureResource(texture); },
  };
}
export function createImageTextureUploader(options: ImageTextureUploaderOptions): ImageTextureUploader {
  validateUploadLimits(options.limits);
  if (typeof options.invalidatePublishedSource !== "function") throw new Error("Image uploads require the host published-source invalidation port.");
  if (!isBorrowedWebGpuEngine(options.scene.getEngine())) return createWebGlImageTextureUploader(options);
  const engine = options.scene.getEngine() as unknown as WebGPUEngine & WebGpuInternals;
  let limits = options.limits;
  let outstanding = 0;
  let lastFrameBytes = 0;
  let uploadedBytes = 0;
  let deviceLost = false;
  let publishedCompletionFailures = 0;
  let lastPublishedCompletionFailure: ImageUploadCompletionFailure | null = null;
  type Job = { request: ImageUploadRequest; texture: ReturnType<typeof allocate>; layer: number; row: number; state: "pending" | "published" | "failed"; completionFailureReported: boolean; off(): void; resolve(texture: UploadedImageTexture): void; reject(error: unknown): void };
  const queue: Job[] = [];
  const flights = new Set<{ bytes: number; ticket: UploadTicket }>();
  const finishFlight = (flight: { bytes: number; ticket: UploadTicket }): void => {
    if (!flights.delete(flight)) return;
    outstanding -= flight.bytes;
    flight.ticket.release();
    if (queue.length) options.requestRender();
  };
  const fail = (job: Job, error: unknown): void => {
    if (job.state !== "pending") return;
    job.state = "failed";
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.off();
    let failure = error;
    try { job.texture.dispose(); }
    catch (cleanupError) { failure = new AggregateError([error, cleanupError], error instanceof Error ? error.message : String(error)); }
    job.reject(failure);
  };
  const completionFailed = (job: Job, error: unknown): void => {
    if (job.state === "pending") { fail(job, error); return; }
    if (job.state !== "published" || job.completionFailureReported) return;
    // The caller owns a published texture. Only the host can invalidate its
    // source/cache/presentation generation; this callback proves no device loss.
    job.completionFailureReported = true;
    publishedCompletionFailures += 1;
    const failure: ImageUploadCompletionFailure = { error, label: job.request.label, texture: job.texture };
    lastPublishedCompletionFailure = failure;
    const invalidationFailed = (invalidationError: unknown): void => {
      // Do not turn host failure into an unhandled rejection or obstruct the
      // remaining native completions. A late host cleanup cannot overwrite a
      // newer source failure. The host's existing policy reads the latest stats.
      if (lastPublishedCompletionFailure === failure) lastPublishedCompletionFailure = { ...failure, invalidationError };
    };
    try {
      const cleanup = options.invalidatePublishedSource(failure);
      if (cleanup !== undefined) void Promise.resolve(cleanup).catch(invalidationFailed);
    } catch (invalidationError) { invalidationFailed(invalidationError); }
  };
  return {
    upload(request) {
      if (deviceLost) throw new Error("The image upload device has been lost.");
      validateUploadRequest(request, options.scene.getEngine().getCaps().maxTextureSize);
      const texture = allocate(options.scene, request);
      return new Promise((resolve, reject) => {
        const abort = (): void => fail(job, request.signal.reason);
        const job: Job = { request, texture, layer: 0, row: 0, state: "pending", completionFailureReported: false, resolve, reject, off: () => request.signal.removeEventListener("abort", abort) };
        queue.push(job);
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort(); else options.requestRender();
      });
    },
    pump() {
      let submitted = 0;
      while (queue.length) {
        const job = queue[0];
        if (job.request.signal.aborted || job.texture.disposed) { fail(job, job.request.signal.reason ?? new Error("Texture disposed during upload.")); continue; }
        const image = job.request.images[job.layer];
        const rowBytes = image.width * 4;
        const frameRows = Math.floor((limits.bytesPerFrame - submitted) / rowBytes);
        const outstandingRows = Math.floor((limits.outstandingBytes - outstanding) / rowBytes);
        // Source behavior: make one row's progress under a small per-frame cap.
        // The shared broker still has final admission authority for that row.
        const nothingSent = submitted === 0 && outstanding === 0;
        const rows = Math.min(image.height - job.row, nothingSent ? Math.max(1, Math.min(frameRows, outstandingRows)) : Math.min(frameRows, outstandingRows));
        if (rows <= 0) break;
        const bytes = rows * rowBytes;
        let flight: { bytes: number; ticket: UploadTicket } | undefined;
        let ready = false;
        try {
          const ticket = job.request.reserveUpload(bytes, `${job.request.label} rows`);
          if (job.state !== "pending" || deviceLost || job.texture.disposed || job.request.signal.aborted) {
            // Admission is a host callback: it can end the operation before any
            // native copy. No unfinished submission owns this returned grant.
            ticket.release(); fail(job, job.request.signal.reason ?? new Error("Image upload ended during admission.")); continue;
          }
          // Native submission can throw after accepting work. Own the grant first.
          flight = { bytes, ticket }; flights.add(flight); outstanding += bytes; submitted += bytes;
          engine._device.queue.copyExternalImageToTexture(
            { source: image, origin: { x: 0, y: job.row }, flipY: false },
            { texture: job.texture.gpuTexture, mipLevel: 0, origin: { x: 0, y: job.row, z: job.layer }, colorSpace: "srgb", premultipliedAlpha: false },
            { width: image.width, height: rows, depthOrArrayLayers: 1 },
          );
          uploadedBytes += bytes;
          if (queue.includes(job) && !job.texture.disposed && !job.request.signal.aborted) {
            job.row += rows;
            if (job.row === image.height) {
              job.row = 0; job.layer += 1;
              if (job.layer === job.request.images.length) {
                if (job.texture.levels > 1) {
                  if (job.texture.kind === "cube") engine._textureHelper.generateCubeMipmaps(job.texture.hardware, job.texture.levels);
                  else engine._textureHelper.generateMipmaps(job.texture.hardware, job.texture.levels, 0);
                }
                ready = true;
              }
            }
          }
        } catch (error) { fail(job, error); }
        if (flight) {
          // Includes partial submissions and mip generation; release on success or loss.
          const submittedFlight = flight;
          if (deviceLost) { finishFlight(submittedFlight); continue; }
          try {
            void engine._device.queue.onSubmittedWorkDone().then(() => finishFlight(submittedFlight), error => { finishFlight(submittedFlight); completionFailed(job, error); });
            // A synchronous completion-hook failure must reject before publishing.
            const index = queue.indexOf(job);
            if (ready && index >= 0 && !job.texture.disposed && !job.request.signal.aborted) {
              queue.splice(index, 1); job.off(); job.texture.markComplete(); job.state = "published"; job.resolve(job.texture);
            }
          }
          catch (error) { fail(job, error); /* Keep the charge until explicit device loss: completion is unknown. */ }
        }
      }
      lastFrameBytes = submitted;
      if (queue.length && (outstanding === 0 || limits.outstandingBytes - outstanding >= queue[0].request.images[queue[0].layer].width * 4)) options.requestRender();
      return submitted;
    },
    busy: () => queue.length > 0,
    setLimits(next) { validateUploadLimits(next); limits = next; if (queue.length) options.requestRender(); },
    stats: () => ({ queuedJobs: queue.length, outstandingBytes: outstanding, lastFrameBytes, uploadedBytes, publishedCompletionFailures, lastPublishedCompletionFailure }),
    cancelAll(reason, cancellation = {}) {
      if (cancellation.deviceLost) deviceLost = true;
      for (const job of [...queue]) fail(job, new Error(reason));
      if (deviceLost) for (const flight of [...flights]) finishFlight(flight);
    },
  };
}
