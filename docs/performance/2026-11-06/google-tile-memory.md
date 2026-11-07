# Google tile memory: 16-bit indices and byte counting — 6 November 2026

Item L5 of the performance limits audit (app
`docs/proposals/performance-limits.md`), P-109 in the performance ledger.
**Held: both halves change pixels.** Nothing is committed but this note.

L5 proposed two things: keep Google tile indices 16-bit, and count each
tile's real bytes so that `map.google.cacheBytes` bounds the cache. Both were
built and measured. Each changes pixels: the indices on WebGPU, and the
counting in views heavier than the default limit. So both wait for the L25
tolerance test and a decision.

## 16-bit indices

The worker kernel (`google-WASM/worker.js`, `copyGeometry`) copies each
primitive's indices into a new `Uint32Array`. The tile stores them as 8- or
16-bit (`sourceIndexComponentType` 5121 or 5123). Babylon uploads an index
buffer at the width of the array it is given (`webgpuEngine.createIndexBuffer`,
`thinEngine._normalizeIndexData`), so every Google tile's index buffer is 32-bit.
The original glTF loader gives Babylon 8- or 16-bit arrays, which upload as
16-bit.

The change tried:

```js
// copyGeometry
indices: sixteenBitIndices(primitive.indices),

function sixteenBitIndices(indices) {
  const narrow = new Uint16Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] > 0xffff) throw new Error("Google index exceeds its 16-bit source");
    narrow[i] = indices[i];
  }
  return narrow;
}
```

`GoogleWorkerPrimitive` and `GooglePreparedPrimitive` were typed
`Uint16Array`. A worker test covered 5121 and 5123 through both cores, values
256 and 65,535, and a failure at 65,536. A preparation test checked that
Babylon keeps the worker's array. All six one-line mutants failed a test.
Those mutants were: widening again, no range check, the check off by one, only
8 bits kept, an array longer than the source, and widening in preparation. The
ground BVH copies any index array into its own `Uint32Array`, and terrain
already gives it 16-bit indices. Picking reads `getIndices()`, which takes
either.

### Memory

The method: headless Chrome 156 on an Apple M5, WebGPU, 1280 × 800 at device
pixel ratio 1, and a new profile for each visit. Google 3D tiles were loaded,
and the camera was placed over downtown Minneapolis (44.9778, −93.265),
heading 20°. Every Google tile mesh in the scene was added up once tiles
stopped streaming for 3 s. "Shown" is under the tiles renderer's root. "Held"
is every tile mesh, since the adapter detaches a hidden tile.

| View | Meshes held (shown) | Index, 32 → 16-bit | Vertex | Texture | Kept JPEG |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1.5 km up, 30° down | 271 (150) | 1.88 → 0.94 MiB | 4.6 MiB | 112.3 MiB | 4.0 MiB |
| 250 m up, 4° down | 568 (375) | — → 3.57 MiB | 16.7 MiB | 281.0 MiB | 9.4 MiB |
| 8 km up, 12° down | 204 (140) | — → 0.38 MiB | 1.3 MiB | 71.7 MiB | 2.4 MiB |

The first view was measured in two interleaved pairs, which agreed exactly,
and the other two with the 16-bit build only. Indices halve, as the audit said,
but they are 1–2% of a tile's memory. Textures are 90–93%. Index memory saved:
about 1 MiB in a view.

### Pixels

The method: `scripts/capture-scenes` with the same view at a fixed time, once
from a build of each.

| Comparison | Differing pixels | Largest channel difference |
| --- | ---: | ---: |
| 32-bit build against itself (one cold, one warm cache) | 12 | 3 |
| 16-bit build against itself | 0 | 0 |
| 32-bit against 16-bit, three times | 841–853 (0.08%) | 31 |

The differing pixels lie on one-pixel lines along tile edges. Three checks
rule out the obvious causes:

- **Not tile arrival or draw order.** With one download and one parse at a
  time (`map.google.downloads=1`, `map.google.parses=1`), tiles arrived in
  the same order in both builds, and 841 pixels still differed. A fixed opaque
  draw order made no difference either.
- **Not the build.** A build made the same way as the control, but with the
  16-bit worker, matched the 16-bit build exactly.
- **The index width alone.** One page of the 16-bit build, view loaded and
  still, took four screenshots. Between them every tile's index buffer was
  rebuilt from the same values: 16-bit, then 32-bit, then 16-bit again, then
  32-bit again. A against A was 0 pixels. 16 against 32 was the same 841
  pixels. 16 against 16 again was 0, and 32 against 32 again was 0. The same
  test on WebGL2 (ANGLE on Metal) gave 0 everywhere.

Babylon builds the same shader and the same pipeline for both widths. The
effect's defines and its vertex and fragment code were compared and are equal,
and a triangle list has no strip index format. So the difference is below
Babylon, in Chrome's WebGPU on Metal. On this machine, a tile edge's pixels
depend on the index format.

## Counting bytes

3d-tiles-renderer's Babylon adapter counts every tile as 1 byte
(`calculateBytesUsed`, `3d-tiles-renderer@0.4.24`). `map.google.cacheBytes`
(307–410 MiB) therefore never binds. `map.google.cacheTiles` (6,000–8,000
tiles) does. At the 380–570 KiB a mesh measured above, 6,000 tiles is
2.2–3.3 GiB before eviction starts. The engine's `map.google.cacheBytes`
reading shows this tile count as bytes.

Counting real bytes would make the cache keep to 307–410 MiB. When the tiles
a view needs pass 410 MiB, the cache is full, and 3d-tiles-renderer queues no
more downloads (`LRUCache.isFull` in `queueTileForDownload` and in its update
loop). The view then stays coarser. The 250 m view above already holds 311 MiB
of GPU memory and kept JPEG at 1280 × 800 and device pixel ratio 1. A 2× display
needs finer tiles for the same view. So at today's limits, counting bytes
changes pixels in heavy views. That is the purpose of a memory bound, but it
needs a decision on the limits.

## Decisions waiting

1. **16-bit indices**: about 1 MiB a view, and 0.08% of pixels on WebGPU
   along tile edges. It is worth taking only if L25's limits accept that.
   Otherwise drop it.
2. **Byte counting**: which `map.google.cacheBytes` default to set, or a
   default scaled to the device. Then L25 on heavy views at 1× and 2×.
   Counting for the reading alone, with no limit from it, would be exact and
   would correct the reading.
