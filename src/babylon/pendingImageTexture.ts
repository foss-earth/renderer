import { Texture, type Scene } from "@babylonjs/core";
export interface PendingImageBody { readonly blob: Blob; release(): void }
/**
 * Compatibility device adapter for Babylon's legacy pending 2D Texture path.
 * Acquisition, cache/meter/budget and object-URL policy are host-owned ports.
 * Preserve noMipmap=false/invertY=false/TRILINEAR and default gamma semantics.
 * Babylon's hidden decode/native upload remain unbounded by this adapter;
 * retaining the encoded body is not shared decode/GPU budget conformance.
 */
export function createPendingImageTexture(options: {
  label: string;
  scene: Scene;
  acquire(signal: AbortSignal): Promise<PendingImageBody>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  onLoad(): void;
  onError(message?: string, exception?: unknown): void;
}): Texture {
  const abort = new AbortController();
  let body: PendingImageBody | null = null;
  let blobUrl: string | null = null;
  const release = (): void => {
    const url = blobUrl;
    const acquired = body;
    blobUrl = null; body = null;
    try { if (url !== null) options.revokeObjectURL(url); }
    finally { acquired?.release(); }
  };
  const texture = new Texture(null, options.scene, false, false, Texture.TRILINEAR_SAMPLINGMODE,
    () => { release(); if (!abort.signal.aborted) options.onLoad(); },
    (message, error) => { release(); if (!abort.signal.aborted) options.onError(message, error); },
  );
  texture.name = options.label;
  texture.onDisposeObservable.add(() => { abort.abort(); release(); });
  void Promise.resolve().then(() => options.acquire(abort.signal)).then(acquired => {
    if (abort.signal.aborted) { acquired.release(); return; }
    body = acquired;
    blobUrl = options.createObjectURL(body.blob);
    texture.updateURL(blobUrl);
  }).catch((error: unknown) => {
    if (abort.signal.aborted) return;
    release(); options.onError(error instanceof Error ? error.message : String(error), error);
  });
  return texture;
}
