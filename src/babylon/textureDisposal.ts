import type { BaseTexture } from "@babylonjs/core";

/** A Babylon disposal observer may throw before the internal texture is released. */
export function disposeTextureResource(texture: BaseTexture): void {
  try { texture.dispose(); } finally { texture.releaseInternalTexture(); }
}

/** Generic resource handles also expose the safe, idempotent disposal to their host. */
export function protectTextureDisposal(texture: BaseTexture): void {
  const dispose = texture.dispose.bind(texture);
  let disposed = false;
  texture.dispose = () => {
    if (disposed) return;
    disposed = true;
    try { dispose(); } finally { texture.releaseInternalTexture(); }
  };
}
