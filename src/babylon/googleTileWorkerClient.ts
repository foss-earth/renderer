/** Worker-owned Google preparation. Structural protocol avoids a native dependency. */
export interface GooglePreparedPrimitive {
  positions: Float32Array; uvs: Float32Array; indices: Uint32Array;
  sourceIndexComponentType: 5121 | 5123; materialIndex: number;
  sampler?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number };
  /** Compressed source for context restoration; absent only for custom device ports. */
  jpeg?: Uint8Array; bitmap: ImageBitmap;
}
export type GooglePreparedTile = { supported: false; reason: string } | {
  supported: true; metadata: Record<string, unknown>; matrix: Float64Array;
  nodeName?: string; meshName?: string; primitives: GooglePreparedPrimitive[];
};
export interface GooglePreparationStatus {
  actual: "idle" | "typescript-worker" | "wasm-single" | "original";
  parity: "not-run" | "same"; fallbackReason?: string;
  jobs: number; failures: number; roundTripMs: number; workMs: number; copyBytes: number;
  pending: number;
}
export interface GoogleTileWorkerPort {
  /** Structural host admission; Renderer does not depend on Engine. */
  readonly compute?: { acquire(request?: { lanes?: number; signal?: AbortSignal }): Promise<GoogleComputeLease> };
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}
interface GoogleComputeLease { readonly lanes: number; release(outcome?: "useful" | "stale" | "failed" | "retired"): void }
export interface GoogleTileWorkerClient {
  decode(bytes: ArrayBuffer, signal?: AbortSignal): Promise<GooglePreparedTile>;
  getStatus(): GooglePreparationStatus;
  /** Record a renderer/profile failure that selects the original loader. */
  fallback(reason: string): void;
  dispose(): void;
}
export function closeGoogleTileBitmaps(tile: GooglePreparedTile): void {
  const failures: unknown[] = [];
  if (tile.supported) for (const primitive of tile.primitives) { try { primitive.bitmap.close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "Google tile bitmap cleanup failed");
}
const abortError = () => new DOMException("Google tile preparation cancelled", "AbortError");
/** No worker starts until a tile arrives. One shared worker, eight jobs and 64 MiB
 * in flight by default; timeouts retire the worker and leave the original loader usable. */
export function createGoogleTileWorkerClient(options: {
  createWorker(): GoogleTileWorkerPort;
  timeoutMs?: number; maxPending?: number; maxPendingBytes?: number;
  /** Match the original Babylon decoder: none for WebGPU, default for WebGL. */
  imageColorSpaceConversion?: "none" | "default";
}): GoogleTileWorkerClient {
  const timeoutMs = options.timeoutMs ?? 15_000, maxPending = options.maxPending ?? 8;
  const maxBytes = options.maxPendingBytes ?? 64 * 1024 * 1024;
  let worker: GoogleTileWorkerPort | undefined, disposed = false, retired = false, nextId = 1, bytesPending = 0;
  const status: GooglePreparationStatus = { actual: "idle", parity: "not-run", jobs: 0, failures: 0,
    roundTripMs: 0, workMs: 0, copyBytes: 0, pending: 0 };
  type Job = { resolve(value: GooglePreparedTile): void; reject(error: unknown): void; start: number;
    byteLength: number; bytes: ArrayBuffer; timer?: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort(): void;
    admission: AbortController; lease?: GoogleComputeLease; dispatched: boolean; cancelled: boolean };
  const jobs = new Map<number, Job>();
  function forget(id: number): Job | undefined {
    const job = jobs.get(id);
    if (job) { jobs.delete(id); clearTimeout(job.timer); job.signal?.removeEventListener("abort", job.abort); bytesPending -= job.byteLength; job.admission.abort(); }
    return job;
  }
  function retire(reason: string) {
    retired = true; status.actual = "original"; status.fallbackReason = reason;
    try { worker?.terminate(); } catch { status.failures++; } worker = undefined;
    for (const id of [...jobs.keys()]) { const job = forget(id); job?.lease?.release("retired"); job?.reject(new Error(reason)); }
  }
  function startWorker() {
    if (worker) return worker;
    worker = options.createWorker();
    worker.onerror = event => { event.preventDefault(); status.failures++; retire(event.message || "Google worker error"); };
    worker.onmessageerror = () => { status.failures++; retire("Google worker message decode failed"); };
    worker.onmessage = event => {
      const reply = event.data;
      if (!reply || reply.version !== 1) { status.failures++; retire("Invalid Google worker reply"); return; }
      if (reply.kind !== "decoded" && reply.kind !== "failed") return;
      const job = reply.generation === 0 ? forget(reply.id) : undefined;
      if (!job) { if (reply.kind === "decoded" && reply.supported) closeGoogleTileBitmaps(reply); return; }
      job.lease?.release(job.cancelled ? "stale" : reply.kind === "failed" || !reply.supported ? "failed" : "useful");
      if (job.cancelled) { if (reply.kind === "decoded" && reply.supported) closeGoogleTileBitmaps(reply); pump(); return; }
      status.roundTripMs += performance.now() - job.start;
      if (reply.kind === "failed") {
        status.failures++; job.reject(new Error(`Google worker ${reply.stage}: ${reply.error?.message}`));
        retire(`Google worker ${reply.stage}: ${reply.error?.message}`); return;
      }
      if (reply.supported !== true && reply.supported !== false) {
        status.failures++; job.reject(new Error("Invalid Google worker output")); retire("Invalid Google worker output"); return;
      }
      status.jobs++; status.actual = reply.actualTier === "single" ? "wasm-single" : "typescript-worker";
      status.parity = reply.parity === "same" ? "same" : "not-run";
      status.fallbackReason = reply.fallbackReason ?? status.fallbackReason;
      status.workMs += Number.isFinite(reply.workMs) ? reply.workMs : 0;
      if (reply.supported) status.copyBytes += reply.matrix.byteLength + reply.primitives.reduce((n: number, p: GooglePreparedPrimitive) => n + p.positions.byteLength + p.uvs.byteLength + p.indices.byteLength + (p.jpeg?.byteLength ?? 0), 0);
      job.resolve(reply);
      pump();
    };
    return worker;
  }
  function dispatch(id: number, job: Job, lease?: GoogleComputeLease): void {
    if (!jobs.has(id) || disposed || retired) { lease?.release("stale"); return; }
    job.lease = lease; job.dispatched = true; job.start = performance.now();
    job.timer = setTimeout(() => { status.failures++; retire("Google worker startup/job timeout"); }, timeoutMs);
    try {
      // Copy after admission. The caller's bytes remain available for fallback.
      const copy = job.bytes.slice(0); status.copyBytes += copy.byteLength;
      worker!.postMessage({ version: 1, id, generation: 0, kind: "decode", bytes: copy, colorSpaceConversion: options.imageColorSpaceConversion ?? "none" }, [copy]);
    } catch (error) { status.failures++; retire(`Google worker dispatch: ${String(error)}`); }
  }
  function pump(): void {
    if (!worker?.compute || [...jobs.values()].some(job => job.dispatched || job.start === -1)) return;
    const next = jobs.entries().next().value;
    if (!next) return;
    const [id, job] = next;
    job.start = -1;
    void worker.compute.acquire({ signal: job.admission.signal }).then(lease => { dispatch(id, job, lease); pump(); }, error => {
      if (forget(id)) job.reject(error);
      pump();
    });
  }
  return {
    decode(bytes, signal) {
      if (disposed || retired) return Promise.reject(new Error(status.fallbackReason ?? "Google worker disposed"));
      if (signal?.aborted) return Promise.reject(abortError());
      if (jobs.size >= maxPending || bytesPending + bytes.byteLength > maxBytes) return Promise.reject(new Error("Google worker queue is full"));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const job: Job = { resolve, reject, start: 0, bytes, byteLength: bytes.byteLength, signal,
          admission: new AbortController(), dispatched: false, cancelled: false,
          abort() {
            if (worker?.compute && job.dispatched) {
              // Caller cancellation is not worker completion. Do not send the
              // kernel's early cancellation acknowledgement or release a lane.
              job.cancelled = true; reject(abortError()); return;
            }
            if (!forget(id)) return;
            try { worker?.postMessage({ version: 1, id, generation: 0, kind: "cancel" }); }
            catch (error) { status.failures++; retire(`Google worker cancellation: ${String(error)}`); }
            finally { reject(abortError()); pump(); }
          } };
        jobs.set(id, job); bytesPending += bytes.byteLength; signal?.addEventListener("abort", job.abort, { once: true });
        try {
          startWorker();
          if (worker!.compute) pump(); else dispatch(id, job);
        } catch (error) { status.failures++; retire(`Google worker dispatch: ${String(error)}`); }
      });
    },
    fallback(reason) { status.actual = "original"; status.fallbackReason = reason; },
    getStatus: () => ({ ...status, pending: jobs.size }),
    dispose() { if (disposed) return; disposed = true; retire("Google tile preparation disposed"); },
  };
}
