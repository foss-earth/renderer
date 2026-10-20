# google-WASM

The Rust twin of [google-TS](../google-TS/index.js): geometry preparation for
Google Photorealistic 3D Tiles, consumed by the renderer's
[prepared Google tiles](../README.md#prepared-google-tiles). Rust validates the
GLB2 envelope (exact JSON then BIN chunks) and bulk-decodes interleaved Float32
positions/UVs and Uint8/Uint16 indices. Float32 words keep their exact bits;
indices are expanded to Uint32 with the source type recorded. All input and
output memory is registry-owned, bounded, copied and released.

Before any numeric work, both twins select the conservative Google profile in
[google-TS/profile.js](../google-TS/profile.js) and otherwise return an
explicit unsupported reason. They keep the complete JSON metadata, including
attribution copyright, plus the node matrix, names, material references,
sampler settings and embedded JPEGs. Nothing is persisted and nothing is
requested except the explicitly loaded WASM binary; caller tile bytes stay in
memory only.

```js
// In a dedicated worker. Installing loads and decodes nothing.
import { createGoogleWorkerKernel } from "@foss-earth/renderer/google-WASM/worker";
import { loadGoogleCore } from "@foss-earth/renderer/google-WASM";
import { createTypeScriptGoogleCore } from "@foss-earth/renderer/google-TS";

createGoogleWorkerKernel(self, { requestedTier,
  start: () => requestedTier === "single" ? loadGoogleCore() : createTypeScriptGoogleCore() });
```

The worker kernel runs the TypeScript reference and the single-threaded WASM
core under the same protocol. It bit-compares the first supported native
geometry, indices, UVs, JPEG bytes and matrix before admission; a startup,
decode or parity failure selects the worker TypeScript implementation with an
explicit reason. `requestedTier: "threaded"` reports its unavailable artifact
and uses worker TypeScript. The app's Google preparation worker selects the
tier from `native.core.google`.

Host decode requests carry `colorSpaceConversion`: `none` for Babylon WebGPU,
`default` for WebGL. JPEGs carrying EXIF metadata keep the original image
loader. ICC-bearing JPEGs also keep the original loader in WebGL: synthetic
Display P3 tests found that direct bitmap upload and worker canvas
normalization both differed from its HTML-image path. WebGPU uses the same
bitmap colour convention as its original loader. These are explicit
quality-preserving fallbacks, not native successes. The supported geometry
profile has one matrix node and one or two unlit primitives; other
hierarchies, attributes, materials, extensions and content envelopes keep the
original loader.

Limits: 64 MiB GLB, 4,194,304 accessor elements, 64 live buffers, 128 MiB total
live payload and 256 MiB linear memory. The raw ABI uses kind 0 bytes and kind 1
Uint32 words; lengths count elements. Unknown or wrong-kind pointers and ranges
are rejected rather than dereferenced. Single worker only; no shared memory.

## Build and checks

From the renderer root:

```sh
npm run build:wasm   # offline; writes single/google.wasm and build-metadata.json
npm run check:wasm   # source and binary receipts, size and Node validation
npm run test:wasm    # tests/google.test.mjs: actual WASM against google-TS, worker admission and fallbacks
npx vitest run tests/googleTilePreparation.test.ts   # the Babylon adapter
```

The build uses installed tools only and fails clearly if
`wasm32-unknown-unknown` is absent; nothing is installed. The Chrome WebGL2 and
WebGPU pixel comparisons of authored fixtures used a local harness that stays
in this repository's ignored `build/google-browser/`, with its evidence. They
qualify those fixtures, not Google network assets; no performance or power
gain is claimed.
