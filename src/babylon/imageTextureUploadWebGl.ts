/** WebGL1/2 row uploads; encoded sRGB, NPOT and fences retain source behavior. */
import { BaseTexture, Constants, type Engine, type InternalTexture } from "@babylonjs/core";
import { textureMipCount, textureRgbaBytes, validateUploadLimits, validateUploadRequest, type ImageTextureUploader, type ImageTextureUploaderOptions, type ImageUploadRequest, type UploadedImageTexture, type UploadCanvas, type UploadTicket } from "./imageUploadTypes.js";
import { withTextureUploadState } from "./textureUploadState.js";
import { disposeTextureResource } from "./textureDisposal.js";

export function createWebGlImageTextureUploader(options: ImageTextureUploaderOptions): ImageTextureUploader {
  validateUploadLimits(options.limits);
  if (typeof options.invalidatePublishedSource !== "function") throw new Error("Image uploads require the host published-source invalidation port.");
  const { scene } = options;
  const engine = scene.getEngine() as Engine;
  const gl = engine._gl;
  if (!gl || engine.webGLVersion < 1) throw new Error("Image uploads need a WebGL or WebGPU renderer.");
  let limits = options.limits;
  let outstanding = 0;
  let uploadedBytes = 0;
  let lastFrameBytes = 0;
  let deviceLost = false;
  let staging: UploadCanvas | null = null;
  let stagingTickets: UploadTicket[] = [];
  let context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
  let stagingOperations = 0;
  let resetStagingRequested = false;
  let pumping = false;
  const quarantinedStaging: { canvas: UploadCanvas; tickets: UploadTicket[] }[] = [];
  const errorsTo = (errors: unknown[], message: string): unknown => errors.length === 1 ? errors[0] : new AggregateError(errors, message);
  const releaseTickets = (tickets: UploadTicket[]): unknown[] => {
    const errors: unknown[] = [];
    for (const ticket of tickets.splice(0)) try { ticket.release(); } catch (error) { errors.push(error); }
    return errors;
  };
  const resetCanvas = (allocation: { canvas: UploadCanvas; tickets: UploadTicket[] }): { retired: boolean; errors: unknown[] } => {
    const errors: unknown[] = [];
    stagingOperations++;
    let retired = false;
    try {
      try { allocation.canvas.width = 0; } catch (error) { errors.push(error); }
      try { allocation.canvas.height = 0; } catch (error) { errors.push(error); }
      let width: number | null = null, height: number | null = null;
      try { width = allocation.canvas.width; } catch (error) { errors.push(error); }
      try { height = allocation.canvas.height; } catch (error) { errors.push(error); }
      retired = width === 0 || height === 0;
    } finally { stagingOperations--; }
    if (retired) errors.push(...releaseTickets(allocation.tickets));
    else if (!errors.length) errors.push(new Error("The host did not retire the image upload staging canvas."));
    return { retired, errors };
  };
  const resetStaging = (): unknown[] => {
    if (stagingOperations) { resetStagingRequested = true; return []; }
    resetStagingRequested = false;
    const canvas = staging, tickets = stagingTickets;
    staging = null; stagingTickets = []; context = null;
    if (!canvas) return releaseTickets(tickets);
    const result = resetCanvas({ canvas, tickets });
    if (!result.retired) quarantinedStaging.push({ canvas, tickets });
    return result.errors;
  };
  const retryStagingRetirement = (): unknown[] => {
    if (stagingOperations) return [];
    const errors: unknown[] = [];
    for (const allocation of [...quarantinedStaging]) {
      const index = quarantinedStaging.indexOf(allocation);
      if (index < 0) continue;
      quarantinedStaging.splice(index, 1);
      const result = resetCanvas(allocation); errors.push(...result.errors);
      if (!result.retired) quarantinedStaging.push(allocation);
    }
    return errors;
  };
  const stagingOperation = <T>(run: () => T): T => {
    stagingOperations++;
    const errors: unknown[] = [];
    let value!: T;
    try { value = run(); } catch (error) { errors.push(error); }
    finally {
      stagingOperations--;
      if (!stagingOperations && resetStagingRequested) errors.push(...resetStaging());
    }
    if (errors.length) throw errorsTo(errors, "Image upload staging operation cleanup failed.");
    return value;
  };
  interface Texture extends UploadedImageTexture { internal: InternalTexture; readonly disposed: boolean; markComplete(): void }
  type Job = { request: ImageUploadRequest; texture: Texture; layer: number; row: number; state: "pending" | "published" | "failed"; off(): void; resolve(texture: UploadedImageTexture): void; reject(error: unknown): void };
  const queue: Job[] = [];
  // Includes fully copied jobs awaiting this frame's fence/flush and handoff.
  // They remain cancellable until ownership actually transfers to the caller.
  const pendingJobs = new Set<Job>();
  const flights: { sync: WebGLSync | null; bytes: number; tickets: UploadTicket[] }[] = [];
  const powerOfTwo = (value: number): boolean => value > 0 && (value & (value - 1)) === 0;
  const allocate = (request: ImageUploadRequest): Texture => {
    const { kind, label } = request;
    const { width, height } = request.images[0];
    const mips = engine.webGLVersion >= 2 || (powerOfTwo(width) && powerOfTwo(height));
    const allocation: { internal: InternalTexture | null } = { internal: null };
    let internal: InternalTexture;
    try {
      internal = withTextureUploadState(engine, () => {
        allocation.internal = kind === "cube"
          ? engine.createRawCubeTexture(null, width, Constants.TEXTUREFORMAT_RGBA, Constants.TEXTURETYPE_UNSIGNED_BYTE, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, null)
          : engine.createRawTexture(null, width, height, Constants.TEXTUREFORMAT_RGBA, false, false, Constants.TEXTURE_BILINEAR_SAMPLINGMODE);
        return allocation.internal;
      }, kind === "cube" ? "cube" : "2d");
    } catch (error) {
      try { allocation.internal?.dispose(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Image texture allocation cleanup failed."); }
      throw error;
    }
    internal.isReady = false; internal.label = label; internal.generateMipMaps = mips;
    let texture: BaseTexture;
    try { texture = new BaseTexture(scene, internal); } catch (error) { internal.dispose(); throw error; }
    texture.name = label;
    texture.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    texture.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    if (kind === "cube") texture.coordinatesMode = Constants.TEXTURE_CUBIC_MODE;
    texture.gammaSpace = request.textureColor?.gammaSpace ?? true;
    const levels = mips ? textureMipCount(width, height) : 1;
    let complete = false;
    let disposed = false;
    return {
      kind, width, height, levels, texture, internal,
      gpuBytes: textureRgbaBytes(width, height, levels, kind === "cube" ? 6 : 1),
      get complete() { return complete; }, get disposed() { return disposed; },
      markComplete() { complete = true; internal.isReady = true; },
      dispose() { if (disposed) return; disposed = true; disposeTextureResource(texture); },
    };
  };
  const pending = (job: Job): boolean => job.state === "pending" && !deviceLost && !job.texture.disposed && !job.request.signal.aborted;
  const strip = (image: ImageBitmap, row: number, rows: number, job: Job): TexImageSource | null => stagingOperation(() => {
    const { request } = job;
    if (row === 0 && rows === image.height) return image;
    if (!staging || staging.width !== image.width || staging.height !== rows || !stagingTickets.length) {
      const next = request.reserveDecodedStaging(image.width * rows * 4, `${request.label} strip canvas`);
      if (!pending(job)) { next.release(); return null; }
      try {
        staging ??= options.createStagingCanvas(image.width, rows);
        stagingTickets.push(next);
        if (!pending(job)) {
          // A returned host canvas remains our unpublished staging allocation.
          // Empty it before relinquishing the grant even if creation cancelled.
          resetStagingRequested = true; return null;
        }
        staging.width = image.width; staging.height = rows; context = null;
      } catch (error) {
        // A returned/partially resized canvas owns the new grant until reset.
        if (!stagingTickets.includes(next)) {
          try { next.release(); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], "Image upload staging admission cleanup failed."); }
        }
        else resetStagingRequested = true;
        throw error;
      }
    }
    if (!pending(job)) return null;
    context ??= staging.getContext("2d", { alpha: false }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!pending(job)) return null;
    if (!context) throw new Error("The host could not create an image upload canvas.");
    context.globalCompositeOperation = "copy"; context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, row, image.width, rows, 0, 0, image.width, rows);
    return pending(job) ? staging : null;
  });
  const fail = (job: Job, error: unknown): void => {
    if (job.state !== "pending") return;
    job.state = "failed"; pendingJobs.delete(job);
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    const errors: unknown[] = [error];
    try { job.off(); } catch (cleanupError) { errors.push(cleanupError); }
    try { job.texture.dispose(); } catch (cleanupError) { errors.push(cleanupError); }
    job.reject(errorsTo(errors, error instanceof Error ? error.message : String(error)));
  };
  const releaseFlight = (index: number): unknown[] => {
    const [flight] = flights.splice(index, 1);
    outstanding -= flight.bytes;
    const errors: unknown[] = [];
    try { if (flight.sync) gl.deleteSync(flight.sync); } catch (error) { errors.push(error); }
    errors.push(...releaseTickets(flight.tickets));
    return errors;
  };
  return {
    upload(request) {
      if (deviceLost) throw new Error("The image upload device has been lost.");
      validateUploadRequest(request, engine.getCaps().maxTextureSize);
      if (request.textureColor?.useSRGBBuffer) throw new Error("Explicit sRGB device storage is unavailable in this WebGL image adapter; supply encoded storage/material gamma flags.");
      const texture = allocate(request);
      return new Promise((resolve, reject) => {
        const abort = (): void => fail(job, request.signal.reason);
        let detached = false;
        const job: Job = { request, texture, layer: 0, row: 0, state: "pending", resolve, reject, off() {
          if (detached) return; detached = true; request.signal.removeEventListener("abort", abort);
        } };
        pendingJobs.add(job); queue.push(job);
        try {
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort(); else options.requestRender();
        } catch (error) { fail(job, error); }
      });
    },
    pump() {
      if (pumping) return 0;
      pumping = true;
      try {
      const pumpErrors = retryStagingRetirement();
      for (const flight of [...flights]) {
        if (!flights.includes(flight)) continue;
        const sync = flight.sync;
        if (!sync) continue; // A failed synchronous finish requires observed context loss.
        try {
          const result = gl.clientWaitSync(sync, 0, 0);
          if (result === gl.TIMEOUT_EXPIRED) continue;
          if (result === gl.WAIT_FAILED) gl.finish();
          const current = flights.indexOf(flight); if (current >= 0) pumpErrors.push(...releaseFlight(current));
        } catch (error) { pumpErrors.push(error); }
      }
      let submitted = 0;
      const frameTickets: UploadTicket[] = [];
      const readyJobs: Job[] = [];
      let premultiply = false, conversion = gl.NONE as number, flipY = false;
      if (queue.length) try {
        premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
        conversion = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) as number;
        flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
      } catch (error) { pumpErrors.push(error); for (const job of [...pendingJobs]) fail(job, error); }
      while (queue.length) {
        const job = queue[0];
        if (job.request.signal.aborted || job.texture.disposed) { fail(job, job.request.signal.reason ?? new Error("Texture disposed during upload.")); continue; }
        const image = job.request.images[job.layer];
        const rowBytes = image.width * 4;
        const frameBytes = engine.webGLVersion >= 2 ? limits.bytesPerFrame : Math.min(limits.bytesPerFrame, limits.outstandingBytes);
        const allowed = Math.min(frameBytes - submitted, limits.outstandingBytes - outstanding - submitted);
        const rows = Math.min(image.height - job.row, submitted === 0 && outstanding === 0 ? Math.max(1, Math.floor(allowed / rowBytes)) : Math.floor(allowed / rowBytes));
        if (rows <= 0) break;
        const bytes = rows * rowBytes;
        const target = job.texture.kind === "cube" ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D;
        let ticket: UploadTicket | undefined;
        let copied = false;
        try {
          ticket = job.request.reserveUpload(bytes, `${job.request.label} rows`);
          if (!pending(job)) { fail(job, job.request.signal.reason ?? new Error("Image upload ended during admission.")); continue; }
          const source = strip(image, job.row, rows, job);
          if (!source || !pending(job)) { fail(job, job.request.signal.reason ?? new Error("Image upload ended during staging.")); continue; }
          engine._bindTextureDirectly(target, job.texture.internal, true);
          try {
            engine._unpackFlipY(false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            if (!pending(job)) { fail(job, job.request.signal.reason ?? new Error("Image upload ended before native copy.")); continue; }
            // A throwing native copy may have submitted part of its work.
            copied = true; submitted += bytes;
            stagingOperation(() => gl.texSubImage2D(job.texture.kind === "cube" ? gl.TEXTURE_CUBE_MAP_POSITIVE_X + job.layer : target, 0, 0, job.row, gl.RGBA, gl.UNSIGNED_BYTE, source));
            uploadedBytes += bytes;
          } finally {
            try { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply); }
            finally {
              try { gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, conversion); }
              finally { try { engine._unpackFlipY(flipY); } finally { engine._bindTextureDirectly(target, null, true); } }
            }
          }
          if (queue.includes(job) && !job.texture.disposed && !job.request.signal.aborted) {
            job.row += rows;
            if (job.row === image.height) {
              job.row = 0; job.layer += 1;
              if (job.layer === job.request.images.length) {
                if (job.texture.levels > 1) {
                  engine._bindTextureDirectly(target, job.texture.internal, true);
                  try { gl.generateMipmap(target); } finally { engine._bindTextureDirectly(target, null, true); }
                  engine.updateTextureSamplingMode(Constants.TEXTURE_TRILINEAR_SAMPLINGMODE, job.texture.internal);
                }
                const index = queue.indexOf(job);
                if (index >= 0) { queue.splice(index, 1); readyJobs.push(job); }
              }
            }
          }
        } catch (error) { fail(job, error); }
        finally {
          if (ticket) {
            if (copied && engine.webGLVersion >= 2) frameTickets.push(ticket);
            else try { ticket.release(); } catch (error) { pumpErrors.push(error); fail(job, error); }
          }
        }
      }
      const frameErrors: unknown[] = [];
      try { if (deviceLost) { frameErrors.push(...releaseTickets(frameTickets)); }
      else if (frameTickets.length) {
        // One fence covers this frame, including mips. A failed fence uses the
        // existing context's finish to avoid freeing still-live staging bytes.
        let sync: WebGLSync | null = null;
        try { sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); } catch { /* Finish the existing context below. */ }
        if (deviceLost) {
          // Loss may reenter during fence creation, before a flight is visible.
          try { if (sync) gl.deleteSync(sync); } catch (error) { frameErrors.push(error); }
          frameErrors.push(...releaseTickets(frameTickets));
        } else {
          const flight = { sync, bytes: submitted, tickets: frameTickets };
          flights.push(flight); outstanding += submitted;
          if (sync) gl.flush();
          else {
            gl.finish();
            // A reentrant observed loss may already have drained this flight.
            const index = flights.indexOf(flight); if (index >= 0) frameErrors.push(...releaseFlight(index));
          }
        }
      } } catch (error) {
        frameErrors.push(error);
      } finally {
      // No idle canvas allocation remains after a frame's synchronous copies.
      frameErrors.push(...resetStaging());
      }
      if (frameErrors.length) {
        const error = errorsTo(frameErrors, "Image upload frame completion cleanup failed.");
        for (const job of readyJobs) fail(job, error);
        pumpErrors.push(...frameErrors);
      }
      for (const job of readyJobs) {
        if (job.state !== "pending") continue;
        if (deviceLost || job.texture.disposed || job.request.signal.aborted) {
          fail(job, job.request.signal.reason ?? new Error(deviceLost ? "The image upload device has been lost." : "Texture disposed before upload publication.")); continue;
        }
        try {
          job.off(); if (!pending(job)) continue;
          job.texture.markComplete(); if (!pending(job)) continue;
          job.state = "published"; pendingJobs.delete(job); job.resolve(job.texture);
        } catch (error) { fail(job, error); pumpErrors.push(error); }
      }
      lastFrameBytes = submitted;
      if (queue.length || flights.some(flight => flight.sync)) try { options.requestRender(); } catch (error) { pumpErrors.push(error); }
      if (pumpErrors.length) throw errorsTo(pumpErrors, "Image upload pump failed.");
      return submitted;
      } finally { pumping = false; }
    },
    busy: () => pendingJobs.size > 0,
    setLimits(next) { validateUploadLimits(next); limits = next; if (queue.length) options.requestRender(); },
    stats: () => ({ queuedJobs: pendingJobs.size, outstandingBytes: outstanding, lastFrameBytes, uploadedBytes, publishedCompletionFailures: 0, lastPublishedCompletionFailure: null }),
    cancelAll(reason, cancellation = {}) {
      if (cancellation.deviceLost) deviceLost = true;
      for (const job of [...pendingJobs]) fail(job, new Error(reason));
      const errors: unknown[] = [];
      if (deviceLost) for (const flight of [...flights]) {
        const index = flights.indexOf(flight); if (index >= 0) errors.push(...releaseFlight(index));
      }
      errors.push(...resetStaging(), ...retryStagingRetirement());
      if (flights.some(flight => flight.sync)) try { options.requestRender(); } catch (error) { errors.push(error); }
      if (errors.length) throw errorsTo(errors, "Image upload cancellation cleanup failed.");
    },
  };
}
