import type { GoogleCore, GooglePrimitive } from "./index.js";

export interface GoogleWorkerIdentity { version: 1; id: number; generation: number; }
/** IDs must be unique for a worker's host; a generation belongs to the host's
 * tile/scene lifetime. The worker echoes it without deciding which is current.
 */
export type GoogleWorkerRequest = GoogleWorkerIdentity & (
  | { kind: "decode"; bytes: ArrayBuffer; colorSpaceConversion?: "none" | "default" }
  | { kind: "cancel" }
  | { kind: "dispose" }
);
export type GoogleWorkerPrimitive = GooglePrimitive & { bitmap: ImageBitmap };
export type GoogleWorkerReply = GoogleWorkerIdentity & (
  | { kind: "decoded"; supported: false; reason: string; actualTier: "single" | "typescript"; parity?: "same" | "not-run"; fallbackReason?: string; workMs?: number; validationStatus: "unvalidated" }
  | { kind: "decoded"; supported: true; actualTier: "single" | "typescript"; parity?: "same" | "not-run"; fallbackReason?: string; workMs?: number; validationStatus: "unvalidated";
      /** Complete original glTF JSON, including copyright/attribution extras. */
      metadata: Record<string, unknown>; matrix: Float64Array; nodeName?: string; meshName?: string;
      primitives: GoogleWorkerPrimitive[] }
  | { kind: "cancelled"; found: boolean }
  | { kind: "disposed" }
) | {
  version: 1;
  /** Malformed requests may have no valid identity. */
  id: number | null;
  generation: number | null;
  kind: "failed";
  stage: "request" | "load" | "decode" | "image" | "post";
  error: { name: string; message: string };
};
export interface GoogleWorkerScope {
  onmessage: ((event: MessageEvent<GoogleWorkerRequest>) => void) | null;
  postMessage(message: GoogleWorkerReply, transfer?: Transferable[]): void;
}
export interface GoogleWorkerOptions {
  /** Threaded has no artifact and explicitly uses the worker TypeScript reference. */
  requestedTier?: "typescript" | "single" | "threaded";
  /** Called lazily on first accepted decode. Defaults to loadGoogleCore. */
  start?: () => GoogleCore | Promise<GoogleCore>;
  /** Receives JPEG Blob with imageOrientation:none, premultiplyAlpha:none and
   * colorSpaceConversion from the host (none by default, matching Babylon WebGPU;
   * default matches Babylon WebGL HTML-image decoding). */
  createImageBitmap?: (blob: Blob, options: ImageBitmapOptions) => Promise<ImageBitmap>;
  Blob?: typeof Blob;
  /** Receives errors that cannot be reported through postMessage, or cleanup
   * failures. Defaults to global reportError or an asynchronous thrown error. */
  onError?: (error: unknown) => void;
}
/** Explicitly install in a dedicated worker. The host transfers caller GLB
 * bytes; no tile network/persistence is performed. At most eight jobs and
 * 64 MiB of source bytes may be pending, and numeric work is serialized.
 *
 * Successful replies transfer fresh geometry buffers and ImageBitmaps to the
 * host. The host owns closing all received bitmaps, including stale replies.
 * Cancel/dispose close only worker-owned bitmaps, also after a pending image
 * promise resolves; synchronous decode cannot be interrupted. Cancel's found
 * flag says whether a job was still pending, not whether an earlier result
 * was already transferred. Filtering stale generations is the host's duty.
 *
 * Unsupported profile results are explicit. WASM startup/decode/parity failures
 * retain the TypeScript kernel in this worker with a fallback reason. Import/installation performs no loading or decode. No renderer,
 * node transform, material or publication policy is applied here.
 */
export function createGoogleWorkerKernel(scope: GoogleWorkerScope, options?: GoogleWorkerOptions): { dispose(): void };
