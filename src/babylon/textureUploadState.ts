import type { AbstractEngine, Engine } from "@babylonjs/core";

/** Babylon raw uploads also mutate flip/alignment state before their native call. */
export function withTextureUploadState<T>(engine: AbstractEngine, submit: () => T, target: "2d" | "cube" = "2d"): T {
  const borrowed = engine as Engine;
  const gl = borrowed._gl;
  if (!gl || borrowed.webGLVersion < 1) return submit();
  const flipY = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
  const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
  const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
  const conversion = gl.getParameter(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL) as number;
  try { return submit(); }
  finally {
    try { gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment); }
    finally {
      try { gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply); }
      finally {
        try { gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, conversion); }
        finally { try { borrowed._unpackFlipY(flipY); } finally { borrowed._bindTextureDirectly(target === "cube" ? gl.TEXTURE_CUBE_MAP : gl.TEXTURE_2D, null, true); } }
      }
    }
  }
}
