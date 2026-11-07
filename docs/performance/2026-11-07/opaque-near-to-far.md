# Drawing opaque meshes near to far, held — 7 November 2026

Item L24 of the performance limits audit (app
`docs/proposals/performance-limits.md`), P-113 in the performance ledger.
Held for the tolerance test (audit L25): it changes a few pixels that are
not all shown to be depth ties, and it gained nothing measurable here.
`renderer.opaqueNearToFar` (Renderer, off) turns it on.

## What happens without it

Babylon sorts each rendering group's opaque submeshes with
`RenderingGroup.PainterSortCompare` (`@babylonjs/core@8.56.2`): by material
id, then mesh id, to save state changes. Every map tile has a material of its
own, so this is about the order tiles were made in. Coarse tiles load first,
so it is close to far first, which shades the most covered fragments. Apple
GPUs remove hidden surfaces before shading, so there it costs nothing. GPUs
that shade every fragment that passes the depth test when it is drawn pay for
the overdraw.

Babylon's `frontToBackSortCompare` cannot do this for opaque meshes:
`RenderingGroup._RenderSorted` measures `_distanceToCamera` only for
see-through submeshes, so for opaque ones it stays 0.

## The change

`createOpaqueOrder` (`src/babylon/opaqueOrder.ts`), made by the renderer
lifecycle:

- Just before the scene's main group (0) sorts, an
  `onBeforeRenderingGroupObservable` observer measures each opaque submesh's
  bounding-sphere centre from the camera that draws it, once per frame and
  per camera.
- The group's opaque order is set to near to far, ties in Babylon's order.
- A draw whose picture could depend on the order stays where Babylon's order
  puts it. That is a draw that does not test depth with the engine's
  function, or writes no depth or no colour, or uses the stencil, or is at no
  finite distance. Only the plain draws between two such draws are
  reordered, among themselves. In the app the sky dome is one: it writes no
  depth. Every frame of the checks below had it and nothing else, so each
  frame had two runs, the plain draws before it and after it.
- Render targets have rendering managers of their own and keep Babylon's
  order. The tables of runs are cleared after the group draws, so no draw is
  kept past its frame.
- Off, the group gets Babylon's own compare function back, and the
  observers go.

Why it should be exact: a plain draw keeps, at each sample, the fragment
nearest by the depth test. A run of plain draws therefore leaves each sample
with its nearest fragment whatever their order, except where two fragments
store exactly the same depth. The draws that stay in place see the same
buffers as before.

The setting is off by default, and off when a host does not register it.

## Tests

`tests/opaqueOrder.test.ts`, a NullEngine scene, records the draw order with
a spy on `SubMesh.prototype.render`:

- near to far when every draw is plain, measured from each frame's camera;
  ties in Babylon's order;
- a draw that writes no depth, tests depth its own way, writes no colour or
  uses the stencil keeps its place, with each run around it sorted; several
  such draws keep Babylon's order among themselves; their place is Babylon's
  order, not the order meshes reach the list; a mesh at a NaN position is
  kept in place too;
- see-through meshes, other groups and render targets keep their own order;
- off and dispose give Babylon's order back and remove both observers.

`tests/rendererLifecycle.test.ts`: off by default, near to far while the
setting is on, live, with a render request.

Mutants, one line each: 18 of 22 caught. The four that survive change
nothing:

- a null material (Babylon returns the scene's default material);
- a `sortNow` reset, which is false only when Babylon's list is missing;
- clearing the runs before measuring, which the clear after each group
  already does;
- keeping the near-to-far compare when off: with no observer it falls back to
  Babylon's order.

Babylon 8's `Observer.remove()` with no argument decrements the observable's
count of deleted observers, which was never incremented, so `hasObservers()`
stays true. The code uses `observable.remove(observer)`, as the rest of the
renderer does.

## In the browser

The method:

- The app built from this tree (`vite build`), headless Chrome on an Apple
  M5 at 1280 × 800, DPR 1, ANGLE on Metal.
- Minneapolis: Google 3D tiles at 1.5 km, looking down 30°; the default map
  at 40 km, looking down 25°. The sun was fixed.
- After loading settled, screenshots with the setting on, off, on, off, in
  one page.

**The order ran.** The main group's opaque list had 48–171 draws, all plain
but the sky dome, so two runs. Sorted, adjacent far-then-near pairs fell from
13–19 to 1 on the default map.

**Pixels**, of 1,024,000:

| View | On against off | Repeats of each arm |
| --- | ---: | ---: |
| Default map, WebGPU | 5, up to 1 level | 0 |
| Default map, WebGL2 | 0 | 0 |
| Google, WebGPU | 61, up to 8 levels | 0 |
| Google, WebGL2 | 41, up to 8 levels | 0 |

The Google differences are small clusters on the ground nearest the camera,
where tiles of different detail overlap.

**Are they depth ties?** A second run took each order with the main group's
depth test made strict: GREATER instead of GEQUAL, since the depth buffer is
reversed. At an exact tie the strict test keeps the first fragment drawn and
the default the last, so a pixel at a tie changes with the test in at least
one order.

- Google, WebGL2: all 41 changed pixels are at ties.
- Google, WebGPU: 48 of 61. The other 13 differ by 1–6 levels, most with no
  tie pixel within 2 pixels. This run does not explain them; MSAA resolves
  are one guess.
- Default map, WebGPU: two shots of the same arm already differed by 12
  pixels in this run, so it says nothing.

**Cost and gain.** Google tiles, dragging at a 4× CPU slowdown, frame
profiler, six interleaved stretches of 5 s:

- WebGPU on Metal: frames 59.7–59.9/s both ways. Render 5.10–5.17 ms a frame
  with it on, 4.96–5.11 ms off. That is about 0.1 ms a frame (the measuring
  and the larger sort), about 6 ms/s.
- WebGL2 on SwiftShader (`--use-angle=swiftshader`), a software GPU that
  shades every fragment, as a proxy for GPUs without hidden-surface removal:
  13.1–13.5 frames/s on, 13.2–13.5 off. No gain.

Not measured: a GPU without hidden-surface removal (most desktop and Android
GPUs). That measurement, and the 13 WebGPU pixels, decide whether L25 should
let it on.

The scripts and raw results are in the app's `build/l24/` (`bench.mjs`
`pixels`, `ties` and `drag`; `diff.mjs`, `where.mjs`, `ties.mjs`), which is
not committed, and the mutants in this repo's `build/l24/`.
