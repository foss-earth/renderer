import { createTypeScriptGoogleCore } from "../google-TS/index.js";
import { loadGoogleCore } from "./index.js";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_JOBS = 8;
const MAX_ELEMENTS = 4_194_304;
const MAX_IMAGE_SIDE = 16384;
const MAX_IMAGE_PIXELS = 16_777_216;
const IMAGE_OPTIONS = Object.freeze({ imageOrientation: "none", premultiplyAlpha: "none", colorSpaceConversion: "none" });
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const typed = (value, name) => ArrayBuffer.isView(value)
  && Object.prototype.toString.call(value) === `[object ${name}]`;
const identity = request => ({ version: 1, id: integer(request?.id, 1) ? request.id : null,
  generation: integer(request?.generation) ? request.generation : null });
const key = request => `${request.id}:${request.generation}`;
function errorData(error) {
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
}
function defaultReportError(error) {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else queueMicrotask(() => { throw error; });
}

// Read only the JPEG marker dimensions before asking the platform decoder to
// allocate an image. No EXIF orientation or image transformation is applied.
function jpegDimensions(bytes) {
  if (!typed(bytes, "Uint8Array") || bytes.length < 4 || bytes.length > MAX_FILE_BYTES
    || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Google texture is not a bounded JPEG");
  let offset = 2, dimensions, unsupportedReason, hasIccProfile = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error("Invalid Google JPEG marker");
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda || marker === 0x00) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || length > bytes.length - offset) throw new Error("Invalid Google JPEG segment length");
    const signature = (name) => Array.from(name, character => character.charCodeAt(0)).every((value, i) => offset + 2 + i < offset + length && bytes[offset + 2 + i] === value);
    if (marker === 0xe1 && signature("Exif\0\0")) unsupportedReason = "JPEG EXIF metadata requires the original image loader";
    if (marker === 0xe2 && signature("ICC_PROFILE\0")) hasIccProfile = true;

    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) throw new Error("Invalid Google JPEG frame");
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE
        || width * height > MAX_IMAGE_PIXELS) throw new RangeError("Google JPEG dimensions exceed worker bounds");
      dimensions = { width, height };
    }
    offset += length;
  }
  if (dimensions) return { ...dimensions, unsupportedReason, hasIccProfile };
  throw new Error("Google JPEG has no supported bounded frame dimensions");
}

function copyGeometry(primitive) {
  if (!primitive || !typed(primitive.positions, "Float32Array") || primitive.positions.length === 0
    || primitive.positions.length % 3 !== 0 || primitive.positions.length > MAX_ELEMENTS * 3
    || !typed(primitive.uvs, "Float32Array") || primitive.uvs.length !== primitive.positions.length / 3 * 2
    || !typed(primitive.indices, "Uint32Array") || primitive.indices.length === 0
    || primitive.indices.length % 3 !== 0 || primitive.indices.length > MAX_ELEMENTS
    || ![5121, 5123].includes(primitive.sourceIndexComponentType) || !integer(primitive.materialIndex)) {
    throw new Error("Invalid Google core primitive output");
  }
  // Transfer only newly owned arrays, including when the supplied core uses
  // subarrays. Never detach caller GLB bytes or a core's WASM memory.
  return { positions: new Float32Array(primitive.positions), uvs: new Float32Array(primitive.uvs),
    indices: new Uint32Array(primitive.indices), sourceIndexComponentType: primitive.sourceIndexComponentType,
    materialIndex: primitive.materialIndex, sampler: primitive.sampler };
}

/** Install explicitly inside a dedicated worker. No worker, fetch or bitmap is
 * created at module import or kernel creation. Only start() may load the WASM
 * artifact; tile bytes are supplied by the host and are never fetched/stored.
 * Cancellation is cooperative across awaits, not preemption of synchronous
 * Rust/JSON work. Host must reject stale generations and close stale bitmaps.
 */
export function createGoogleWorkerKernel(scope, {
  start = loadGoogleCore,
  requestedTier,
  createImageBitmap: decodeBitmap = globalThis.createImageBitmap?.bind(globalThis),
  Blob: BlobPort = globalThis.Blob,
  onError = defaultReportError,
} = {}) {
  if (typeof document !== "undefined") throw new Error("Google geometry worker must be installed in a worker");
  if (!scope || typeof scope.postMessage !== "function" || typeof start !== "function" || typeof onError !== "function") {
    throw new TypeError("Google worker needs message, startup and error ports");
  }
  let disposed = false, pumping = false, pendingCore, pendingBytes = 0, admitted = false, fallbackReason;
  const reference = createTypeScriptGoogleCore();
  if (requestedTier === "threaded") fallbackReason = "Threaded Google WASM is unavailable; using TypeScript in the worker";
  const queue = [], jobs = new Map();
  function report(error) {
    try { onError(error); }
    catch (reportFailure) {
      queueMicrotask(() => { throw new AggregateError([error, reportFailure], "Google worker error port failed"); });
    }
  }
  const active = job => !disposed && !job.cancelled;
  const getCore = () => pendingCore ??= Promise.resolve().then(() => requestedTier === "threaded" ? reference : start()).then(core => {
    if (!core || typeof core.decodeGlb !== "function" || !["single", "typescript"].includes(core.actualTier)
      || core.validationStatus !== "unvalidated") throw new Error("Invalid Google worker core");
    return core;
  });
  const closeBitmaps = job => {
    const failures = [];
    for (const bitmap of job.bitmaps) {
      try { bitmap.close(); } catch (error) { failures.push(error); }
    }
    job.bitmaps.clear();
    if (failures.length) report(new AggregateError(failures, "Google worker bitmap cleanup failed"));
  };
  function failure(request, stage, error) {
    if (disposed) return;
    try { scope.postMessage({ ...identity(request), kind: "failed", stage, error: errorData(error) }); }
    catch (postError) { report(new AggregateError([error, postError], "Google worker could not post its failure")); }
  }
  function forget(job) {
    if (jobs.get(job.key) !== job) return;
    jobs.delete(job.key); pendingBytes -= job.byteLength; job.bytes = null;
  }
  async function run(job) {
    let stage = "load";
    try {
      if (!active(job)) return;
      let core;
      try { core = await getCore(); } catch (error) { fallbackReason = `WASM startup: ${errorData(error).message}`; core = reference; pendingCore = Promise.resolve(reference); }
      if (!active(job)) return;
      stage = "decode";
      const workStart = performance.now();
      let decoded;
      try {
        decoded = core.decodeGlb(job.bytes);
        if (core.actualTier === "single" && !admitted && decoded.supported) {
          const expected = reference.decodeGlb(job.bytes);
          const equal = (a, b) => {
            if (a.byteLength !== b.byteLength) return false;
            const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
            return left.every((value, i) => value === right[i]);
          };
          if (!expected.supported || !equal(decoded.matrix, expected.matrix) || decoded.primitives.length !== expected.primitives.length
            || decoded.primitives.some((p, i) => ["positions", "uvs", "indices", "jpeg"].some(k => !equal(p[k], expected.primitives[i][k])))) throw new Error("Google first-use geometry parity mismatch");
          admitted = true;
        }
      } catch (error) {
        if (core.actualTier !== "single") throw error;
        fallbackReason = `WASM decode/parity: ${errorData(error).message}`; admitted = false;
        core = reference; pendingCore = Promise.resolve(reference); decoded = reference.decodeGlb(job.bytes);
      }
      job.bytes = null;
      if (!active(job)) return;
      if (decoded?.supported === false) {
        if (typeof decoded.reason !== "string") throw new Error("Invalid Google unsupported result");
        stage = "post";
        scope.postMessage({ ...identity(job), kind: "decoded", supported: false, reason: decoded.reason,
          actualTier: core.actualTier, validationStatus: "unvalidated", parity: admitted ? "same" : "not-run", fallbackReason, workMs: performance.now() - workStart });
        return;
      }
      if (decoded?.supported !== true || typeof decoded.metadata !== "object" || decoded.metadata === null
        || !typed(decoded.matrix, "Float64Array") || decoded.matrix.length !== 16
        || !Array.isArray(decoded.primitives) || decoded.primitives.length < 1 || decoded.primitives.length > 2) {
        throw new Error("Invalid Google core tile output");
      }
      if (typeof decodeBitmap !== "function" || typeof BlobPort !== "function") {
        throw new Error("Google worker needs createImageBitmap and Blob ports for JPEG decode");
      }
      const imageDimensions = decoded.primitives.map(primitive => jpegDimensions(primitive.jpeg));
      const unsupportedImage = imageDimensions.find(dimensions => dimensions.unsupportedReason || dimensions.hasIccProfile && job.colorSpaceConversion === "default");
      if (unsupportedImage) {
        scope.postMessage({ ...identity(job), kind: "decoded", supported: false, reason: unsupportedImage.unsupportedReason ?? "JPEG ICC colour profile requires the original WebGL image loader",
          actualTier: core.actualTier, validationStatus: "unvalidated", parity: admitted ? "same" : "not-run", fallbackReason, workMs: performance.now() - workStart });
        return;
      }
      const matrix = new Float64Array(decoded.matrix), primitives = [];
      const transfer = [matrix.buffer];
      for (const [index, primitive] of decoded.primitives.entries()) {
        if (!active(job)) return;
        stage = "decode";
        const geometry = copyGeometry(primitive);
        stage = "image";
        const dimensions = imageDimensions[index];
        // Blob snapshots JPEG bytes before the asynchronous platform decode.
        let bitmap = await decodeBitmap(new BlobPort([new Uint8Array(primitive.jpeg)], { type: "image/jpeg" }), { ...IMAGE_OPTIONS, colorSpaceConversion: job.colorSpaceConversion ?? "none" });
        if (!bitmap || typeof bitmap.close !== "function") throw new Error("Google bitmap port returned an invalid image");
        job.bitmaps.add(bitmap);
        if (!active(job)) return;
        if (bitmap.width !== dimensions.width || bitmap.height !== dimensions.height) {
          throw new Error("Google decoded JPEG dimensions changed");
        }
        // Retain compressed bytes on the renderer for context restoration rather
        // than keeping decoded bitmap pixels alive for every resident tile.
        const jpeg = new Uint8Array(primitive.jpeg);
        primitives.push({ ...geometry, jpeg, bitmap });
        transfer.push(geometry.positions.buffer, geometry.uvs.buffer, geometry.indices.buffer, jpeg.buffer, bitmap);
      }
      if (!active(job)) return;
      stage = "post";
      // Keep the complete glTF JSON object, including asset.copyright and any
      // attribution extras. The host applies renderer transform/material rules.
      scope.postMessage({ ...identity(job), kind: "decoded", supported: true, actualTier: core.actualTier, parity: admitted ? "same" : "not-run", fallbackReason, workMs: performance.now() - workStart,
        validationStatus: "unvalidated", metadata: decoded.metadata, matrix,
        nodeName: decoded.nodeName, meshName: decoded.meshName, primitives }, transfer);
      // A successful post transfers ownership; never close host-owned images.
      job.bitmaps.clear();
    } catch (error) {
      closeBitmaps(job);
      if (active(job)) failure(job, stage, error);
    } finally { closeBitmaps(job); forget(job); }
  }
  async function pump() {
    if (pumping || disposed) return;
    pumping = true;
    try {
      while (!disposed && queue.length) {
        const job = queue.shift();
        await run(job);
      }
    } finally { pumping = false; }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (scope.onmessage === listener) scope.onmessage = null;
    queue.length = 0;
    for (const job of jobs.values()) { job.cancelled = true; closeBitmaps(job); job.bytes = null; }
    jobs.clear(); pendingBytes = 0; pendingCore = undefined;
    // A createImageBitmap promise cannot be aborted: run() closes any bitmap
    // that resolves later. No result or error reply is sent after disposal.
  }
  const listener = event => {
    const request = event?.data;
    if (disposed) return;
    try {
      if (!request || request.version !== 1 || !integer(request.id, 1) || !integer(request.generation)) {
        throw new Error("Invalid Google worker version or job identity");
      }
      if (request.kind === "dispose") {
        dispose();
        try { scope.postMessage({ ...identity(request), kind: "disposed" }); }
        catch (error) { report(error); }
      } else if (request.kind === "cancel") {
        const job = jobs.get(key(request));
        if (job) {
          job.cancelled = true; closeBitmaps(job);
          const queued = queue.indexOf(job);
          if (queued !== -1) { queue.splice(queued, 1); forget(job); }
        }
        scope.postMessage({ ...identity(request), kind: "cancelled", found: !!job });
      } else if (request.kind === "decode") {
        if (!(request.bytes instanceof ArrayBuffer) || request.bytes.byteLength < 28 || request.bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error("Google worker needs a bounded transferred GLB ArrayBuffer");
        }
        if (request.colorSpaceConversion !== undefined && !["none", "default"].includes(request.colorSpaceConversion)) throw new Error("Invalid Google JPEG colour conversion");
        const jobKey = key(request);
        if (jobs.has(jobKey)) throw new Error("Google worker job identity is already pending");
        if (jobs.size >= MAX_PENDING_JOBS || pendingBytes + request.bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error("Google worker queue is full");
        }
        const job = { ...identity(request), key: jobKey, bytes: request.bytes, colorSpaceConversion: request.colorSpaceConversion,
          byteLength: request.bytes.byteLength, cancelled: false, bitmaps: new Set() };
        jobs.set(jobKey, job); pendingBytes += job.byteLength; queue.push(job);
        void pump().catch(report);
      } else throw new Error("Unknown Google worker operation");
    } catch (error) { failure(request, "request", error); }
  };
  scope.onmessage = listener;
  return { dispose };
}
