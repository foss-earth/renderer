# @foss-earth/renderer

Render scheduling, readiness checks and generic GPU resource ownership for FOSS Earth, over a device the host supplies.

The pure contracts initialize no device, scene, backend or global singleton. The optional Babylon bootstrap creates the selected backend and scene only when the host calls it. Engine, sky, image adapters and aircraft visuals all use the host's scheduler through these contracts.

## Entries

| Export | Contents |
| --- | --- |
| `@foss-earth/renderer` and `/core` | Scheduler, readiness and resource ownership, pure selection types and remembered-mode storage functions. No Babylon, React or DOM imports. `/core` is the same module as the root. |
| `/browser` | `createBrowserRenderScheduler`, with optional frame ports and a browser animation-frame fallback. Creates one core scheduler. `observeResourceTiming` and `readHeapBytes` feed the network and memory sources. |
| `/babylon` | Backend and scene bootstrap, presentation probe and candidates, scene readiness, browser environment factories, supplied-runtime lifecycle, texture upload and transfer helpers. Optional peer `@babylonjs/core@8.56.2`. |
| `/panel` | Renderer panel and frame budget panel, built from a supplied registry, document/input realm and UI-owned factories. |
| `/settings` | Renderer parameter records and experiment/legacy 360 handoff views. Uses public types from `@foss-earth/ui/settings`. |
| `/profiling` | Rolling timing summaries and traces, resource streams for the streamgraphs, network and memory sources, and injected measurement-session lifetime. Also exported by the root. Needs a host monotonic clock. |
| `/frame-budget.css` | Styles for the frame budget table. Generic control and section styles come from [`@foss-earth/ui`](https://github.com/foss-earth/ui). |
| `/diagnostics` | Mesh inspector, vector drawing and performance metrics over the host scene. Canvas device, clock, memory and feature readings are injected. |
| `/vite` | Node-only Vite plugins `babylonShaderChunks()` and `babylonBarrels()`, with `BABYLON_SHADER_GROUPS` and `BABYLON_BARREL`. See [Babylon build support](docs/vite.md). |

Entries are ESM JavaScript with declarations in `dist/`. Babylon, `@foss-earth/ui` and Vite are optional peers. Pure consumers need none of them; `@foss-earth/ui` is used for types only. Loading the Babylon entry imports backend code but constructs no engine or scene.

Further documents: [host ports](docs/host-contracts.md) and [borrowed frame and native retirement](docs/native-frame-retirement.md).

## Scheduler and resources

```ts
import { createRenderScheduler, createRendererResourceLifecycle } from "@foss-earth/renderer";

const scheduler = createRenderScheduler({
  tick: drawChangedFrame,
  requestFrame: host.requestFrame,
  cancelFrame: host.cancelFrame,
  minFrameIntervalMs: () => host.frameRateCap > 0 ? 1000 / host.frameRateCap : 0,
});
const resources = createRendererResourceLifecycle({
  identity: { rendererId: "main", backendId: host.backendId, deviceId: host.deviceId },
  requestRender: scheduler.requestRender,
});

// Capture BEFORE asynchronous creation, so late results cannot get a new token.
const generation = resources.currentGeneration();
const texture = await host.createHiddenTexture();
const owned = resources.adopt(generation, {
  value: texture,
  dispose: value => value.dispose(),
  whenReady: value => host.whenTextureReady(value),
});
if (owned) await owned.commitVisible(value => host.showTexture(value));
```

Host functions that need their receiver must be bound before they are injected.

Retire resources with `invalidate(newIdentity)` before replacing or destroying a backend or device, and call `dispose()` before final device destruction. Both dispose accepted resources once. `adopt` also disposes a stale or foreign incoming object immediately. A readiness completion from a retired generation cannot show content or request a frame. Host readiness may keep doing its own asynchronous work until it settles; cancelling that work is the provider's job. Do not transfer one resource object into two ownership scopes.

Prepare new content hidden. `commitVisible` waits for readiness, applies a synchronous host change, then requests one frame through the supplied scheduler. Remove what the new content replaces inside that callback for a single handover. The helper is for mutations, not download progress. Releasing hidden resources requests no frame, releasing visible resources requests one, and retiring a whole generation requests one frame for all visible removals.

### Scheduler behavior

- Requests coalesce. Continuous reference counts, the `shouldKeepRendering` predicate (for example camera inertia), host frame-rate limits, pause/resume, active-state notifications and permanent stop are supported.
- The scheduler needs frame ports and uses their monotonic millisecond timestamp. `/browser` supplies the animation-frame fallback when no ports are given.
- `renderer.frameRateCap` is a host setting in frames per second. The injected `minFrameIntervalMs` turns it into the least time between draws. The scheduler adds no frame-rate limiting or camera inertia of its own.
- `createRenderScheduler` returns a `WorkRenderScheduler`, which adds `requestWork()` to the base `RenderScheduler`. Options add `work(timeMs)` and `shouldKeepWorking()`. Neither adds a clock, timer or frame authority.
- Each requested frame runs work before considering presentation. Work also runs on frames withheld by the frame-rate limit, so the cap does not delay hidden work. `requestWork()` alone never calls `tick()`. A visible change requested during work can paint once in the same frame; a request during paint waits for the next frame.
- `shouldKeepWorking()` must be true only for runnable or in-flight work, and false for capacity-refused resources. Those wake `requestWork()` themselves when they can proceed; the scheduler does not poll capacity.
- Pause retires pending frame and work wakes before cancellation and idle notifications, so a stale callback cannot clear a newer frame or paint. Unpause requests the first visible frame. Stop permanently clears requests, continuous references and observers. Independent cancel and notification actions are all attempted and errors are reported in order. A callback failure is reported after activity cleanup, with no implicit paint or retry.

### Readiness

The Babylon adapter batches visible mesh and light changes within a task, and requests one frame through the same scheduler. It also handles hidden-mesh preparation, adaptive readiness checks, post-process readiness, cancellation and compile-failure settlement. The host can supply the readiness policy from settings.

| Parameter | Unit | Default | Bounds | Reason |
| --- | --- | --- | --- | --- |
| `firstCheckIntervalMs` | ms | 16 | finite, > 0 | Notice a newly ready object within about one display frame. |
| `maxCheckIntervalMs` | ms | 250 | finite, >= first interval | Bound idle checking cost for slow or failed resources. |
| `backoffFactor` | ratio | 1.5 | finite, >= 1 | Reduce checks while no readiness progress occurs. |
| probe `frames` | count | 3 | integer, >= 1 | Expose asynchronous presentation failures. |
| probe `settleFrameCount` | count | 4 | integer, >= 0 | Allow delayed WebGPU errors after each submit. |
| probe `settleMs` | ms | 75 | finite, >= 0 | Wait for a final presentation error. |

## Backend selection and lifecycle

Backend creation keeps the remembered Auto choice, reports forced modes and the actual WebGL version, enables reverse depth before scene creation, and uses large-world rendering, right-handed scenes and explicit pointer picking. WebGPU is probed first on a throwaway canvas, with normal antialias and device-pixel settings and then a safe fallback without them. If the probes fail, it falls back to WebGL and keeps the requested mode and the reason. Only a WebGPU start is saved as the preference (`foss-earth:renderer-preference`), separate from `renderer.backend`. A WebGPU failure is saved instead as a fallback (`foss-earth:renderer-fallback`) with its reason, its time, and what it depended on: the secure context, `navigator.gpu` and the user agent. Automatic mode starts WebGL from it without waiting for WebGPU to fail again, until one of those changes or three days pass, and then tries WebGPU again. A passed probe is saved too (`foss-earth:renderer-webgpu-verified`), with the options it passed with, the user agent and the time. For 30 days a start in the same browser with the same options skips the probe, which takes about 0.4 s, and watches the page canvas's first frames for the same presentation errors instead. On one, it forgets the passed probe and reloads the page (the host's `reload`), so the next start probes and can fall back to WebGL. A chosen WebGL is not saved, and a WebGL preference saved by an earlier version is ignored. Automatic mode starts WebGL without saving it where the device can present immersive VR, except on an Android phone: Chrome there answers `immersive-vr` with true for Cardboard on every phone, so only a headset's browser counts. `describeRendererStart` words the line a host prints in its log when the renderer starts on WebGL. Bootstrap creates no render loop or scheduler.

The optional browser host supplies storage, device pixel ratio, diagnostics, probe canvases and presentation waits. `applyRendererChoice` needs settings, location and storage; it reloads the page and removes both legacy URL overrides.

Failed WebGPU initialization releases its engine, the deprecated engine-only factory disposes the scene it does not return, and probe engine disposal continues if scene disposal throws. A rejected asynchronous initialization falls back to WebGL.

`createBabylonRendererLifecycle` binds the supplied selection, scene, scheduler, registry and platform. It handles resolution and device pixel ratio, frame-limit wake-up, visibility and resize listeners, presentation filtering, scene readiness, device-loss generation and restoration, and `beginFrame`/render/`endFrame` bracketing. The host supplies camera clipping and device-loss teardown callbacks.

- It owns neither the scene or device nor the scheduler. Exposure and fill belong to the sky package.
- Dispose it before stopping the scheduler, then dispose features, scene and engine in the host's order.
- A failed startup releases every observer and subscription it acquired and restores the original presentation candidate function. Cleanup attempts every owned stop even if one throws, and detached callbacks do nothing. Settings already applied to the supplied registry or device are host state and are not rolled back.
- All still-registered restore listeners are attempted independently. Listeners removed by an earlier listener, or by a disposed binding, are not called. One live frame request is attempted separately. Errors are reported in callback order, then the request error.
- A begun frame ends once. If preparation or render and `endFrame` both fail, both errors are kept in that order. A failed `beginFrame` has no matching `endFrame`, and `afterRender` runs only after successful preparation, render and completion.
- WebGPU bootstrap uses a device-owner adapter for Babylon 8.56.2: it awaits
  replacement-device initialization, rebuilds retained scene and virtual-scene
  geometry, and then publishes Babylon's restored event. Duplicate losses
  share one restore; losses of a replacement are handled serially. Disposal
  prevents late restoration and destroys an unreturned replacement device.
  Failed restoration is reported through bootstrap diagnostics (or the
  console) and leaves presentation waiting. Hosts reacquire feature resources
  after the ordinary restored event. WebGL keeps Babylon's restoration path.
  These ordering and ownership rules have unit coverage; hardware restoration
  requires a browser gate on the actual backend.

Resource identity strings describe the host's actual backend and device. The package does not use them to infer WebGPU or WebGL support.

## Image uploads and texture transfers

`createImageTextureUploader` borrows the supplied scene and device and takes one image or six caller-ordered cube layers. Representation owners choose the order, acquire and decode images, and reserve source GPU allocations.

- Each submission receives an upload ticket from the shared image broker. Tickets must outlive operation-scope cancellation. Reserve them directly from broker pools; the renderer releases them after queue completion, a GL2 fence or finish, or observed device loss. Partial submission errors keep their tickets too.
- GL1 consumes external pixels synchronously. WebGL cropped strip canvases get separate decoded and staging grants and are zeroed after synchronous copies.
- Cube textures are published only after all six layers and their mips are submitted and the completion hook is registered. Readiness and display handover stay with the host.
- Call `pump()` only from the host's existing frame. Adapters for a retired device refuse further uploads; construct a replacement against the restored device.
- `ImageTextureUploaderOptions.invalidatePublishedSource(failure)` is required. `ImageUploadCompletionFailure` is `{error, label, texture}`. The host retires its cache, source and presentation generation synchronously and may return a promise for later cleanup. A native completion failure before publication rejects and disposes the pending upload. After publication, the failure is reported once per job and the texture, now owned by the caller, is never disposed. The callback does not confirm device loss. A throwing or rejected callback is caught so later completions can still release their grants. `stats().publishedCompletionFailures` counts reports, `lastPublishedCompletionFailure` holds the latest (with `invalidationError` if the callback failed), and a late callback error cannot overwrite a newer failure. The host should check the failed texture against the resource and generation it owns, so a late failure for retired content does not invalidate newer content. There is no retry.
- Unpublished WebGL jobs can be cancelled while the final fence is being created or flushed. Cancellation rejects every pending job but keeps already submitted grants until the fence or finish shows completion; only observed context loss releases them early. A failed job can never be published. Admission, canvas, context and binding ports can cancel synchronously, and later draws or copies into cancelled ownership are suppressed. A grant with no native submission is released immediately.
- `ImageUploadRequest.textureColor: {useSRGBBuffer, gammaSpace}` sets storage and material metadata explicitly. Bounded legacy map uploads pass `{useSRGBBuffer: false, gammaSpace: true}`. If omitted, the 360 defaults apply: sRGB storage and material gamma off on WebGPU, encoded storage and material gamma on on WebGL. Explicit sRGB native storage is not implemented by the WebGL adapter and is rejected before allocation. RGBA8, `invertY=false`, legal mipmaps and trilinear sampling are fixed. WebGL1 non-power-of-two images skip illegal mips and use bilinear sampling. Device maximum side, kind and layer dimensions and color flag types are validated before allocation. U/V clamp is the default; a legacy map consumer must reapply any wrap or repeat override to the returned `BaseTexture`.

`createTextureTransferTracker({ scene, admit, requestRender })` tracks immediate map and raw transfers on the same backend. `transfer(bytes, label, submit)` admits before submitting and throws before calling `submit` if admission is refused. `track(ticket, submit)` takes a grant the caller has already admitted, with no second broker. Call `pump()` from the same host frame for GL2 fences. A ticket belongs to one submission and must not be passed twice. The tracker owns an admitted ticket before it invokes `submit`.

- Unknown native completion keeps its charge until actual device loss. Disposal alone does not show GPU work has finished.
- If `submit` disposes the tracker while still issuing work, GL2 finishes only after `submit` returns. A failed finish keeps the hold until context loss. A fence or flush port that re-enters teardown cannot leave a new fence behind a disposed pump. No timer or replacement device is created.

It returns a `CompletionTextureTransferTracker`, which keeps `transfer`, `track`, `pump`, `deviceLost` and `dispose` and adds `tryAdmit`. The types `TextureTransferOutcome`, `TextureTransferRetirement`, `TextureTransferAdmission` and `TryAdmitTextureTransfer` are exported from the root and Babylon entries.

`tryAdmit(bytes, label, retainInput: () => () => void)` returns `null` if the whole upload grant is unavailable, without retaining or copying input. Otherwise it owns the grant before calling the retain port. The admission has `active`, `settled`, `retired`, `submit(copy)` and `cancel(reason?)`.

- `settled` never rejects. It is `{status: "uploaded"}` only after proven completion, `{status: "failed", error}` for a copy, cancellation or completion-observer failure, or `{status: "device-lost"}`. A failed or cancelled result cannot later become uploaded.
- `active` stays true during a healthy admission, the synchronous copy and the native wait. Cancellation, a terminal result, disposal or loss makes it false. The copy callback receives `isActive()` and should stop issuing regions after a re-entrant cancel.
- `retired` never rejects and is separate from publication. `{status: "completed" | "device-lost", cleanupError?}` means no native use remains, or no work was submitted. Every input release and ticket release is attempted once, independently, with errors recorded in order. The host should observe both promises and apply its error policy to `cleanupError`.
- Cancellation and ordinary disposal do not prove GPU completion. A rejected or throwing `onSubmittedWorkDone` is reported as a failure, but the input and grants stay held until actual device loss. Loss is never inferred from the rejection.

`createTextureDevicePorts({ scene, transfer, tryAdmit? })` validates the scene, device limits and update metadata, creates raw textures and forwards region, cube-face and mip updates. With `tryAdmit` it also provides `prepareRawTextureBatch`; without it, a batch request fails before native allocation. A `RawTextureBatchRequest` is `{regions, label, retainInput, reserveCopy}`, and each region is `{texture, data: Uint8Array, x, y, width, height, faceIndex?, lod?, generateMipMaps?}`.

- The host owns each texture. The renderer validates RGBA8 storage, exact region byte length, coordinate, layer and mip bounds, and the total byte sum before admission.
- `retainInput()` holds the producer's pages and returns its release function. `reserveCopy(bytes, label)` must obtain a separate decoded/staging grant from the same image broker, returning an `UploadTicket` or throwing a capacity refusal; it cannot return `null`.
- Only after upload admission, input retention and copy admission does the renderer make private `Uint8Array` snapshots. Caller buffers are never detached, and later changes to them cannot alter the captured bytes or order. There is no borrow or worker-transfer mode. A copy admission failure returns an inactive, failed, unsubmitted batch with independent cleanup.
- A `PreparedRawTextureBatch` is `{bytes, active, settled, retired, submit(), cancel()}`. The owner should register its generation and slot job before `submit()`, refuse a `null` or `!active` batch, keep slot ownership, producer holds and snapshot charges until `retired`, and publish only a successful, still-current `settled` result. On failure or loss it must invalidate its table or generation, and it must not reuse submitted slots before retirement. Region order, mip contents, atlas layout, residency and table publication belong to the engine or other feature.

`createImageRegionDevicePorts({ scene, track })` creates mutable 2D textures and copies bitmaps or bytes using already-admitted tickets. GL pixel and binding state is restored after a throwing copy. Disposing a texture always releases its allocation even if a Babylon observer throws, and an unreturned allocation is cleaned up if transfer tracking throws after creation. Layout, atlas tables, residency and shader conventions stay with [`@foss-earth/engine`](https://github.com/foss-earth/engine) and the cube-map packages.

`createCanvasTextureDevicePorts({ scene, createCanvas, transfer })` supplies an HTML or offscreen canvas before `DynamicTexture` allocation. It exposes `createTexture({ name, width, height, mipmaps, samplingMode? })` and `updateTexture(texture, flipY)`. Updates admit the actual canvas width x height x 4 bytes through the supplied tracker, keep the native flip and mip policy, and reject foreign or disposed handles. Hosts and feature owners still account for retained GPU and canvas memory. Pixel generation, compass geometry and marker styling are not part of the renderer.

WebGL staging cleanup attempts the width reset, height reset, both dimension reads and every ticket release independently. A zero dimension must be observed before the decoded grant is returned. A canvas whose release cannot be proven stays in a quarantine list with every grant held; each new strip allocation needs its own admission from the same broker, so capacity bounds that list. The host's `pump()` and `cancelAll()` may retry retirement. Device loss alone does not prove a decoded canvas has freed its pixels. A reset during an active canvas or native copy callback is deferred until the callback returns. Ready peer jobs, abort detachment, texture disposal, fence deletion and ticket release are each attempted even after another cleanup fails. A re-entrant `pump()` does not submit twice.

`createPendingImageTexture` is a legacy adapter over Babylon `Texture.updateURL`. Its acquisition and object-URL ports keep the encoded body alive through Babylon load and disposal. Babylon's hidden decode and upload are not charged to the broker by this adapter, so hosts should either state that limitation or move to the bounded decoder and uploader ports for full accounting.

## Profiling

`createFrameProfiler({ now, ... })` provides rolling summaries, nested sections, concurrent GPU and background work, percentiles, trace tags and window, and cheap disabled paths. `now` is required and is the host monotonic millisecond clock. CPU measurements that start at clock zero are kept.

`createFrameProfileSession({ profiler, measure, canTimeGpuFrames })` only manages measurement attachment and teardown. The Babylon entry's `createFrameProfileSession({ scene, engine, now })` supplies Babylon phase and GPU measurements, or accepts an existing `profiler`. The host calls `session.frame()` once, before the work in its single rendered frame. No timer, frame queue or second device is created.

`frameProfilingParameters(home)` defines the seven `renderer.profiling.*` settings with their IDs, units, bounds, defaults and session-only flags: measuring, the summarised window, the table refresh, the trace, and the streamgraphs' history, sample length and shape. `bindFrameProfileSettings` takes a structural `get`/`watch` port that the host registry satisfies. Detach it before disposing the session. If a later watch fails during binding, earlier watches are detached. Detaching attempts every acquired watch once, never disposes the session or registry, and stale callbacks cannot reconfigure the session afterwards.

`createFrameBudgetPanel` requires `session`, `settings`, `ui: { document, createParameterControl }`, `refreshPort: { nowMs, subscribe }` and `actions: { copy, saveJson, onError? }`. It limits refreshes to the `renderer.profiling.refreshMs` interval using the host's refresh notifications, and does no refresh work while hidden or off. Clipboard and download policy, readings, notes and optional visibility are injected. `fixtures/profiling-host.ts` shows the wiring. Its own refreshes are timed as `profiler/panel`, so the profiler's cost shows in the table it draws.

### Streamgraphs

`session.streams` keeps the last `renderer.profiling.streamSeconds` (60 s) of five resources in samples of `renderer.profiling.streamMs` (250 ms): CPU and GPU time in ms per second, GPU memory and main memory in bytes held, and network in bytes received per second. The panel draws each as a streamgraph by owner, with its legend as the text alternative; the pointer shows any moment's figures.

- CPU and GPU come from the frame profiler's sections, drained once per sample: `map/raster tiles` is the map's, `gpu/globe` the globe pass. A parent's time outside the children it names is its `/other`.
- `createGpuMemorySource` (Babylon entry), registered by the Babylon session, estimates GPU memory from Babylon's textures, mesh buffers and canvas, at most once a second. `gpuMemoryOwner` names owners from Babylon names. Browsers do not report GPU memory.
- `createMemorySource({ heapBytes })` adds owners that count their own bytes with `track(owner, bytes, { inHeap })`, and the rest of the JavaScript heap where the browser reports one.
- `createNetworkSource({ observe, owner, metered })` names each request from Resource Timing. Servers that hide sizes from it, as most tile servers do, are counted by the host with `received(owner, bytes)` and listed in `metered`, so nothing counts twice. Requests whose size stays hidden are named in a note, never guessed at.

A resource no source measures is shown as not available, never as zero. Measuring off, nothing is sampled, observed or kept: sources start with measuring and stop with it, and each start begins a fresh history. The sampling is timed as `profiler/streams`.

## Diagnostics

- `createMeshInspector(scene, { requestRender, whenReady })` provides selection, wireframe overlays, hidden readiness and disposal. Its handle fits the UI package's `MeshInspectorPanelPort`; the host supplies its own roots and registers the panel. The renderer owns drawing; the engine owns WGS84 horizon culling and globe geometry.
- `createVectorDebugDrawing(scene, parent, options)` draws arrows and arcs with label cadence and ready-before-reveal behavior. Enabling labels needs the host's `CanvasTextureDevicePorts`, checked before any geometry is allocated or settings change. The host calls `update(vectors, timeSeconds, alreadyScheduled)`, with the timestamp in seconds. Label textures are 512 x 80 pixels with bilinear sampling and no mips. Host accounting of retained allocations still applies.
- `createPerformanceMetrics` requires monotonic milliseconds, memory bytes or `null`, and host tile and culling observations. `frameSampleCount` is a positive whole number set by the host (default 120). `update` observes once when the host asks; `getSnapshot` and `format` do not poll. Draw calls are always `null` because they are not measured.

## Limits

- The renderer covers backend and scene selection, presentation and readiness, renderer parameters, the optional panels and catalogue, and generic resource ownership. It does not include the full Babylon runtime, map, terrain, camera or sky composition, or format-specific resource factories. Those belong to the host application and other repositories.
- WebGPU and WebGL hardware behavior is not covered by the mocked bootstrap and `NullEngine` tests.

## Development

`@foss-earth/renderer` has an optional peer and dev dependency on `@foss-earth/ui`, which it names by a version that is not published. Its own `npm install`, tests and build therefore do not work on their own yet. Develop it through the app, which uses libraries straight from their checkouts: see [local source](https://github.com/foss-earth/app#local-source).

The checks in `package.json` are `typecheck`, `lint`, `test` (Vitest, 50% of workers), `build` and `test:consumer`. The consumer test loads the emitted public exports and shares one fake frame queue with a Babylon `NullEngine` adapter, and compiles the pure API with `ES2022` and no DOM library or Node types.

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
