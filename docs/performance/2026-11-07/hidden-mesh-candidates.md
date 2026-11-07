# Offering Babylon only enabled meshes — 7 November 2026

Item L8 of the performance limits audit (app
`docs/proposals/performance-limits.md`), P-110 in the performance ledger.
Exact: the same meshes are drawn, in the same order.

## What happens without it

Each frame, `Scene._evaluateActiveMeshes` walks every mesh in the scene
(`@babylonjs/core@8.56.2`, `scene.js:3771`). For each mesh, before it asks
`isEnabled()`, it:

1. looks up the camera's level of detail in a `Map` and writes `-1` into it;
2. reads `isBlocked`;
3. adds `getTotalVertices()` to the scene's vertex counter;
4. calls `isReady()`.

Map tiles that the caches keep but do not show are disabled. The raster
runtime disables a tile's mesh (`createRasterTilesRuntime.ts`, `setEnabled`).
3d-tiles-renderer detaches a hidden Google tile and disables its root. So in a
session, much of the walk passes over meshes that Babylon then skips.

## The change

`createPresentationCandidates` (`src/babylon/presentationCandidates.ts`)
already replaced `scene.getActiveMeshCandidates` for the 360 view's
presentation layer. It now has a second filter: offer only the meshes whose
`isEnabled()` holds, in the scene's order. The filter runs when Babylon asks
for candidates, just before its walk. The two filters combine.

- Setting: `renderer.skipDisabledMeshes`, a boolean in the renderer tab
  (level "all"), default on and applied live. With it off, Babylon's own
  candidates are back. A host that does not register the setting gets the
  filter on.
- Why the renderer, not the engine: the audit put L8 in the engine, using
  each tiles runtime's shown set. But only one owner can replace
  `getActiveMeshCandidates`, and the renderer lifecycle already replaces it.
  Two replacements would undo each other. Asking `isEnabled()` is also exact
  without trusting either runtime's bookkeeping, and it covers both runtimes
  and any other disabled mesh.

## Why it is exact

For a mesh that is not enabled, Babylon's loop does only steps 1–4 above and
then `continue`. None of them changes what is drawn:

- **The level-of-detail entry** (`_internalAbstractMeshDataInfo._currentLOD`)
  is read only inside the same loop, after it is reset (`scene.js:3822–3829`;
  no other reader in `@babylonjs/core`).
- **`isBlocked`, `getTotalVertices()` and `isReady()`** (with
  `completeCheck` false) only read state.
- **The vertex counter** (`scene.getTotalVertices()`,
  `totalVerticesPerfCounter`) now counts enabled meshes only. Nothing in
  engine, renderer, app or ui reads it. The Babylon inspector would show the
  smaller number.

The filter calls the same `isEnabled()` as Babylon, on the same frame, and
nothing between the filter and the walk enables or disables a mesh. The only
other caller of `getActiveMeshCandidates` is `_renderWithFrameGraph`. FOSS
Earth uses no frame graph, render target list or second active camera.

## Tests

- `tests/presentationCandidates.test.ts`, on a `NullEngine` scene:
  - **Differential test.** It runs 60 frames, with tiles and their roots
    switched on and off at random, meshes removed and added, and meshes that
    Babylon skips for other reasons (not visible, visibility 0, outside the
    camera's layer mask, outside the frustum). Each frame renders with
    Babylon's candidates and with the filter. The active meshes are equal, in
    order. 100 or more disabled meshes are skipped over the run.
  - **Exact candidate list.** The filter offers the enabled meshes, in scene
    order. Still offered: an invisible mesh, a layer-masked mesh and a mesh
    that is not ready. Not offered: a disabled mesh and a mesh under a
    disabled root.
  - **Filters together.** Each filter stays installed while the other is on,
    and the two combine while presenting. Babylon's function is back once
    both are off or the filter is disposed.
- `tests/rendererLifecycle.test.ts`: the setting defaults on. Off brings back
  Babylon's function and asks for a frame. On installs the filter again.
- `src/settings/catalogue.test.ts`: the catalogue entry and its default.
- **Mutants.** All 13 one-line mutants fail a test. A scratch script applied
  each one and ran the three test files. The mutants: ancestors ignored, inverted, no filter, invisible
  meshes dropped too, not-ready meshes dropped too, skip-alone returning every
  mesh, installed for presentation only, reversed order, dispose keeping the
  filter, the lifecycle never skipping, the lifecycle ignoring the setting, no
  watch, default off.

## Pixels

The method:

- Headless Chrome 156 on an Apple M5, 1280 × 800 at device pixel ratio 1, sun
  fixed at 2026-06-21 18:00 UTC.
- One page per map and backend. The view loaded and still, then screenshots
  with the setting on, off, on, off.
- Views: Google 3D tiles over downtown Minneapolis (1.5 km up, 30° down), and
  the default map 40 km up, 25° down.

| Map | Backend | Meshes (enabled) | Differing pixels, on against off, on, off |
| --- | --- | ---: | ---: |
| Google | WebGPU | 596 (341) | 0, 0, 0 |
| Google | WebGL2 | 428 (187) | 0, 0, 0 |
| Default | WebGPU | 113 (87) | 0, 0, 0 |
| Default | WebGL2 | 113 (87) | 0, 0, 0 |

## Time

The method:

- One page per map, WebGPU, frame profiler on.
- First, 20 s of mouse drag at 1× to bring tiles in and leave some hidden.
- Then six 6 s stretches, still dragging, at a 4× CPU slowdown, the setting
  alternating on/off, off/on, on/off.
- Each stretch's profiler window is reset first, and the stretch reads
  "render/active meshes". That section includes the filter, since Babylon
  asks for candidates inside it.

| Map | Meshes (enabled) | Off, ms a frame (ms/s) | On, ms a frame (ms/s) | Frames/s, both |
| --- | --- | --- | --- | --- |
| Google | 836 (308–341) | 1.63–1.75 (48.6–52.1) | 1.03–1.13 (30.7–33.7) | 29.8–29.9 |
| Default | 173 (84–99) | 0.42–0.48 (12.6–14.2) | 0.31–0.35 (9.4–10.5) | 29.8 |

The frame rate did not change: the gain is main-thread time. The startup
audit's phone drag at 4× (`profile.mjs --target app --phone --rates 4`, one
run each way, default map) gave `_evaluateActiveMeshes` 18.2 → 16.5 ms/s
inclusive and 6.8 → 4.5 ms/s self. That is one pair, so it is only a check
of direction.

What is left: at 1×, after a 20 s Google drag (1,510 meshes, 638 disabled),
one evaluation took:

| Candidates | ms per evaluation |
| --- | ---: |
| Babylon's own | 0.295 |
| This filter | 0.252 |
| A list of the enabled meshes made in advance | 0.239 |

That last list is the floor. Reaching it needs a list kept up to date as tiles
show and hide, and an exact way to know when it is stale. The remaining
0.013 ms is not worth that yet.
