import type { AbstractEngine, InternalTexture, Scene } from "@babylonjs/core";
import type { ResourceSink, ResourceSource } from "../profiling/resourceStreams.js";

/**
 * GPU memory by owner, estimated: browsers do not report it, so the source
 * adds up what Babylon holds. Each texture is its size, format, faces, layers,
 * mip levels and samples; each mesh buffer its capacity, counted once however
 * many meshes share it; the canvas its colour, depth and multisample buffers.
 * Drivers pad and compress, so the real figure differs.
 *
 * A texture or mesh is named by its Babylon name, and `owner` turns names into
 * owners, such as "imagery" for "imagery-atlas". Walking every texture and
 * buffer takes a while with thousands of tiles, so the source walks at most
 * once per `walkMs` and repeats its last figures in between.
 */
export interface GpuMemorySourceOptions {
  engine: AbstractEngine;
  scene: Scene;
  /** The owner of a named texture or mesh; null leaves it to the source's own guess. */
  owner?(name: string, kind: "texture" | "mesh"): string | null;
  /** ms between walks; 1000 when omitted. */
  walkMs?: number;
}

const FORMAT = {
  alpha: 0, luminance: 1, luminanceAlpha: 2, rgb: 4, rgba: 5, red: 6, rg: 7,
  redInteger: 8, rgInteger: 9, rgbInteger: 10, rgbaInteger: 11, bgra: 12,
  depth24Stencil8: 13, depth32Float: 14, depth16: 15, depth24: 16, depth24UnormStencil8: 17, depth32FloatStencil8: 18, stencil8: 19,
} as const;

/** Channels per texel of an uncompressed colour format. */
function channels(format: number): number {
  switch (format) {
    case FORMAT.alpha: case FORMAT.luminance: case FORMAT.red: case FORMAT.redInteger: return 1;
    case FORMAT.luminanceAlpha: case FORMAT.rg: case FORMAT.rgInteger: return 2;
    case FORMAT.rgb: case FORMAT.rgbInteger: return 3;
    default: return 4;
  }
}

/** Bytes per channel of a texture type, or per texel for a packed one (negated). */
function typeBytes(type: number): number {
  switch (type) {
    case 1: case 6: case 7: return 4; // float, int, unsigned int
    case 2: case 4: case 5: return 2; // half float, short, unsigned short
    case 8: case 9: case 10: return -2; // packed 16-bit texels
    case 11: case 12: case 13: case 14: return -4; // packed 32-bit texels
    case 15: return -8; // float depth with stencil
    default: return 1;
  }
}

/** Bytes per texel, or per texel on average for a block-compressed format. */
export function texelBytes(format: number, type: number): number {
  switch (format) {
    case FORMAT.depth16: return 2;
    case FORMAT.depth24: case FORMAT.depth24Stencil8: case FORMAT.depth24UnormStencil8: case FORMAT.depth32Float: return 4;
    case FORMAT.depth32FloatStencil8: return 8;
    case FORMAT.stencil8: return 1;
  }
  // DXT1, ETC1 and ETC2 without alpha: 8 bytes per 4×4 block.
  if ((format >= 33776 && format <= 33777) || (format >= 35916 && format <= 35917) || format === 36196 || (format >= 37492 && format <= 37495)) return 0.5;
  // BPTC, DXT3/5, ETC2 with alpha, ASTC 4×4: 16 bytes per 4×4 block.
  if (format >= 33778 && format <= 33779 || format >= 35918 && format <= 35919 || format >= 36492 && format <= 36495 || format >= 37496 && format <= 37497 || format >= 37808 && format <= 37853) return 1;
  // 16-bit normalised formats carry their own channel size.
  if (format === 33322) return 2;
  if (format === 33324) return 4;
  if (format === 32852 || format === 36762) return 6;
  if (format === 32859 || format === 36763) return 8;
  if (format === 36760) return 2;
  if (format === 36761) return 4;
  const bytes = typeBytes(type);
  return bytes < 0 ? -bytes : channels(format) * bytes;
}

/** What one texture takes, estimated from its shape, format and samples. */
export function textureBytes(texture: Pick<InternalTexture, "width" | "height" | "depth" | "format" | "type" | "generateMipMaps" | "mipLevelCount" | "samples" | "isCube" | "is3D" | "is2DArray">): number {
  const width = Math.max(0, texture.width), height = Math.max(0, texture.height);
  if (!width || !height) return 0;
  const depth = Math.max(1, texture.depth);
  const layers = texture.isCube ? 6 : texture.is2DArray ? depth : 1;
  const largest = Math.max(width, height, texture.is3D ? depth : 1);
  const levels = texture.mipLevelCount > 1 ? texture.mipLevelCount : texture.generateMipMaps ? Math.floor(Math.log2(largest)) + 1 : 1;
  let texels = 0;
  for (let level = 0; level < levels; level++) {
    texels += Math.max(1, width >> level) * Math.max(1, height >> level) * (texture.is3D ? Math.max(1, depth >> level) : 1);
  }
  return texels * layers * texelBytes(texture.format, texture.type) * Math.max(1, texture.samples);
}

/** The owner a name suggests: its first word, so "imagery-atlas" and "imagery page table" are both "imagery". */
export function ownerFromName(name: string): string {
  const word = /^[^\s\-_/.:#[(]+/.exec(name.trim())?.[0];
  return word ? word.toLowerCase() : "unnamed";
}

interface Holding { owner: string; bytes: number }

export function createGpuMemorySource(options: GpuMemorySourceOptions): ResourceSource {
  const walkMs = Math.max(0, options.walkMs ?? 1000);
  let lastWalk = -Infinity;
  let held: Holding[] = [];
  const ownerOf = (name: string | undefined, kind: "texture" | "mesh"): string => {
    if (!name) return kind === "texture" ? "unnamed textures" : "unnamed meshes";
    return options.owner?.(name, kind) ?? ownerFromName(name);
  };

  const walk = (): Holding[] => {
    const { engine, scene } = options;
    const totals = new Map<string, number>();
    const add = (owner: string, bytes: number): void => {
      if (bytes > 0) totals.set(owner, (totals.get(owner) ?? 0) + bytes);
    };
    const names = new Map<InternalTexture, string>();
    for (const texture of scene.textures) {
      const internal = texture.getInternalTexture();
      if (internal && texture.name && !names.has(internal)) names.set(internal, texture.name);
    }
    for (const texture of engine.getLoadedTexturesCache()) {
      add(ownerOf(names.get(texture) ?? texture.label, "texture"), textureBytes(texture));
    }
    const buffers = new Set<unknown>();
    for (const geometry of scene.geometries) {
      let bytes = 0;
      const vertexBuffers = geometry.getVertexBuffers();
      if (vertexBuffers) {
        for (const kind in vertexBuffers) {
          const data = vertexBuffers[kind].getBuffer();
          if (!data || buffers.has(data)) continue;
          buffers.add(data);
          bytes += data.capacity;
        }
      }
      const indices = geometry.getIndexBuffer();
      if (indices && !buffers.has(indices)) {
        buffers.add(indices);
        bytes += indices.capacity;
      }
      add(ownerOf(geometry.meshes[0]?.name, "mesh"), bytes);
    }
    const width = engine.getRenderWidth(), height = engine.getRenderHeight();
    const samples = Math.max(1, (engine as { currentSampleCount?: number }).currentSampleCount
      ?? (engine.getCreationOptions().antialias ? 4 : 1));
    // Two presented colour buffers, and colour plus depth at the sample count.
    add("canvas", width * height * (2 * 4 + (samples > 1 ? samples * 4 : 0) + samples * 4));
    return [...totals].map(([owner, bytes]) => ({ owner, bytes }));
  };

  return {
    kinds: ["vram"],
    start() {
      lastWalk = -Infinity;
      held = [];
    },
    sample(sink: ResourceSink, window) {
      if (window.end - lastWalk >= walkMs) {
        held = walk();
        lastWalk = window.end;
      }
      for (const holding of held) sink.add("vram", holding.owner, holding.bytes);
      sink.note("vram", "Estimated from what Babylon holds; the browser does not report GPU memory.");
    },
    stop() {
      held = [];
    },
  };
}
