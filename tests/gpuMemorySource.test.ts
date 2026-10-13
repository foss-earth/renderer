import type { AbstractEngine, Scene } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import { createGpuMemorySource, ownerFromName, texelBytes, textureBytes } from "../src/babylon/gpuMemorySource.js";
import type { ResourceSink } from "../src/profiling/resourceStreams.js";

const shape = (overrides: Partial<Parameters<typeof textureBytes>[0]> = {}) => ({
  width: 256, height: 256, depth: 1, format: 5, type: 0, generateMipMaps: false, mipLevelCount: 1,
  samples: 1, isCube: false, is3D: false, is2DArray: false, ...overrides,
});

describe("texture bytes", () => {
  it("counts each texel by its format and type, block-compressed ones by their average", () => {
    expect(texelBytes(5, 0)).toBe(4); // RGBA, unsigned byte
    expect(texelBytes(7, 0)).toBe(2); // RG, unsigned byte
    expect(texelBytes(6, 1)).toBe(4); // red, float
    expect(texelBytes(5, 2)).toBe(8); // RGBA, half float
    expect(texelBytes(5, 10)).toBe(2); // packed 16-bit texels
    expect(texelBytes(15, 0)).toBe(2); // depth 16
    expect(texelBytes(18, 0)).toBe(8); // depth 32 float with stencil
    expect(texelBytes(33776, 0)).toBe(0.5); // DXT1
    expect(texelBytes(37808, 0)).toBe(1); // ASTC 4×4
  });

  it("adds mip levels, cube faces, array layers, 3D depth and samples", () => {
    const level0 = 256 * 256 * 4;
    expect(textureBytes(shape())).toBe(level0);
    expect(textureBytes(shape({ generateMipMaps: true }))).toBe((65536 + 16384 + 4096 + 1024 + 256 + 64 + 16 + 4 + 1) * 4);
    expect(textureBytes(shape({ mipLevelCount: 3, generateMipMaps: true }))).toBe((65536 + 16384 + 4096) * 4);
    expect(textureBytes(shape({ isCube: true }))).toBe(6 * level0);
    expect(textureBytes(shape({ is2DArray: true, depth: 3 }))).toBe(3 * level0);
    expect(textureBytes(shape({ is3D: true, width: 4, height: 4, depth: 4, generateMipMaps: true }))).toBe((64 + 8 + 1) * 4);
    expect(textureBytes(shape({ samples: 4 }))).toBe(4 * level0);
    expect(textureBytes(shape({ width: 0 }))).toBe(0);
  });

  it("names an owner by a name's first word", () => {
    expect(ownerFromName("imagery-atlas")).toBe("imagery");
    expect(ownerFromName("Night lights")).toBe("night");
    expect(ownerFromName("#3")).toBe("unnamed");
  });
});

describe("GPU memory source", () => {
  function setup() {
    const internal = (label: string | undefined, overrides: Partial<Parameters<typeof textureBytes>[0]>) => ({ ...shape(overrides), label });
    const atlas = internal(undefined, { width: 1024, height: 1024 });
    const lights = internal("night-lights", { width: 2, height: 2 });
    const plain = internal(undefined, { width: 1, height: 1 });
    const textures = [atlas, lights, plain];
    const vertices = { capacity: 1000 }, indices = { capacity: 200 };
    const tile = (name: string) => ({
      getVertexBuffers: () => ({ position: { getBuffer: () => vertices } }), getIndexBuffer: () => indices, meshes: [{ name }],
    });
    const engine = {
      getLoadedTexturesCache: () => textures,
      getRenderWidth: () => 10, getRenderHeight: () => 10,
      currentSampleCount: 4, getCreationOptions: () => ({ antialias: true }),
    } as unknown as AbstractEngine;
    const scene = {
      textures: [{ name: "imagery-atlas", getInternalTexture: () => atlas }],
      geometries: [tile("tile-1"), tile("tile-2"), { getVertexBuffers: () => null, getIndexBuffer: () => null, meshes: [] }],
    } as unknown as Scene;
    const source = createGpuMemorySource({ engine, scene, owner: name => name.startsWith("tile") ? "map/terrain" : null, walkMs: 1000 });
    const sample = (end: number) => {
      const held: Record<string, number> = {};
      const notes: string[] = [];
      const sink: ResourceSink = {
        add: (kind, owner, amount) => { expect(kind).toBe("vram"); held[owner] = (held[owner] ?? 0) + amount; },
        unavailable: () => undefined,
        note: (_kind, text) => notes.push(text),
      };
      source.sample(sink, { start: end - 250, end });
      return { held, notes };
    };
    return { source, sample, textures, internal };
  }

  it("adds textures by name, shared buffers once, and the canvas at its sample count", () => {
    const { source, sample } = setup();
    source.start?.();
    const { held, notes } = sample(1000);
    expect(held).toEqual({
      imagery: 1024 * 1024 * 4,
      night: 2 * 2 * 4,
      "unnamed textures": 4,
      "map/terrain": 1200,
      canvas: 10 * 10 * (2 * 4 + 4 * 4 + 4 * 4),
    });
    expect(source.kinds).toEqual(["vram"]);
    expect(notes[0]).toMatch(/Estimated/);
  });

  it("walks at most once per walkMs and repeats its figures in between", () => {
    const { source, sample, textures, internal } = setup();
    source.start?.();
    sample(1000);
    textures.push(internal("sky-dome", { width: 8, height: 8 }));
    expect(sample(1500).held.sky).toBeUndefined();
    expect(sample(2000).held.sky).toBe(8 * 8 * 4);
    source.stop?.();
    source.start?.();
    expect(sample(2100).held.sky).toBe(8 * 8 * 4);
  });
});
