# @foss-earth/renderer

Private `0.1.0` extraction candidate for `foss-earth/renderer`. It owns render
scheduling, readiness checks, and generic resource ownership over the device
supplied by its host. Pure contracts initialize no device, scene, backend or
global singleton; the optional Babylon bootstrap creates the selected backend
and scene when the host invokes it. Engine, sky, image adapters and aircraft visuals use the
same host scheduler through these contracts.

YOU CANNOT HAVE AI AS A CO-AUTHOR, OR YOUR CONTRIBUTIONS WILL BE REJECTED.

## Public entries

| Export | Contract |
| --- | --- |
| `@foss-earth/renderer` and `/core` | Scheduler/readiness/resource ownership, pure selection types, remembered-mode storage functions and their types. No Babylon/React/DOM initialization or imports. |
| `/browser` | `createBrowserRenderScheduler`, with the old scheduler's optional frame ports and browser animation-frame fallback. Creates one core scheduler. |
| `/babylon` | Backend/scene bootstrap, presentation probe/candidates, scene readiness, browser environment factories and supplied-runtime lifecycle. Exact optional peer `@babylonjs/core@8.56.2`. |
| `/panel` | Source Renderer panel through supplied registry, document/input realm and UI-owned factories. |
| `/settings` | Source Renderer parameter records and generic experiment/legacy 360 handoff views; public type-only `@foss-earth/ui/settings@0.1.0`. |
| `/profiling` | Pure rolling timing summaries/traces and injected measurement-session lifetime, also exported by root/core. Requires the host monotonic clock. |
| `/frame-budget.css` | Renderer-owned frame budget table styles; generic control/section styles come from UI. |
| `/diagnostics` | Optional generic mesh inspector, vector drawing and performance observations over the host scene. Host canvas device, clock, memory and feature readings are injected. |

Published entries resolve to ESM JavaScript and declarations in `dist/`, with
`.js` imports. `/core` is the same module as the root, so consuming both creates
no second implementation. Babylon is an optional peer; pure consumers need not
install it. The Babylon entry imports backend code but constructs no engine or
scene when loaded. The UI dependency is optional, exact `@foss-earth/ui@0.1.0`,
and type-only in the library's emitted JavaScript. Pure consumers need neither
peer. The current diagnostics/UI mesh-inspector fixture requires a newly checked
UI artifact. The earlier foundation receipt qualifies its earlier source only;
it does not qualify this unchecked increment or publication approval.

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

Host functions that need their receiver must be bound before injection. Retire
resources with `invalidate(newIdentity)` before replacing/destroying a backend
or device, and call `dispose()` before final device destruction. These methods
dispose accepted resources once; `adopt` also disposes a stale/foreign incoming
object immediately. A readiness completion from a retired generation cannot
show content or request a frame. Host readiness may still perform its own
asynchronous work until it settles; cancellation of provider work remains the
provider's responsibility. Do not transfer the same resource object into two
ownership scopes.

Prepare new content hidden. `commitVisible` waits for readiness and applies a
synchronous host change, then requests one frame through the supplied authority.
Remove what it replaces in that callback for a single handover. This helper is
for mutations, not download progress. When Babylon detects a mesh/light change
in the same task, its request coalesces through the same scheduler. Releasing
hidden resources requests no frame; releasing visible resources requests one.
An entire generation retirement requests one frame for all visible removals.

## Preserved behavior and compatibility

The scheduler preserves coalescing, continuous reference counts, inertia's
`shouldKeepRendering`, host frame-rate limits, pause/resume, active-state
notifications and permanent stop. It now requires frame ports and uses their
monotonic millisecond timestamp. The old runtime's no-options frame fallback
belongs in `/browser`; `createBrowserRenderScheduler` exposes the original
optional `requestFrame`/`cancelFrame` options. The primary application owner
must adapt its compatibility facade, retaining one existing scheduler.

The Babylon adapter preserves task-batched visible mesh/light changes,
last-frame membership, preparation suppression, adaptive readiness checks,
hidden-mesh preparation, post-process readiness, cancellation, and compile
failure settlement. Its readiness policy can be supplied by host settings.

Backend creation preserves remembered Auto choice, forced-mode reporting and
actual WebGL version, reverse depth before scene creation, large-world rendering,
right-handed scenes and explicit pointer picking. WebGPU is checked on a
throwaway canvas first, with normal antialias/device-pixel settings then the
source safe fallback without them. Failed probes lead to WebGL while retaining
the requested mode and reason. Preferences describe the mode that worked,
separate from `renderer.backend`. Bootstrap creates no runRenderLoop/scheduler.
The optional browser host supplies storage, DPR, diagnostics, probe canvases and
presentation waits. `applyRendererChoice` requires settings/location/storage,
preserving reload and deletion of both old URL overrides.

`createBabylonRendererLifecycle` binds the supplied selection, scene, scheduler,
registry and platform. It extracts resolution/DPR handling, frame-limit wake-up,
visibility/resize listeners, presentation filtering, scene readiness, device-loss
generation/restoration and beginFrame/render/endFrame bracketing. Hosts supply
camera clipping and device-loss lease teardown callbacks. Dispose this binding
before stopping the scheduler, then dispose features, scene and engine in host
order. It owns neither scene/device nor scheduler. Exposure/fill remain Sky-owned.
Partial startup failure releases every acquired observer/subscription and restores
the original presentation candidate function. Cleanup attempts every owned stop
even when one throws, and detached callbacks are inert. Settings values already
applied to the supplied registry/device are host state and are not rolled back.

| Readiness parameter | Unit | Default | Bounds | Reason |
| --- | --- | --- | --- | --- |
| `firstCheckIntervalMs` | ms | 16 | finite, > 0 | Notice a newly ready object within roughly one display frame. |
| `maxCheckIntervalMs` | ms | 250 | finite, >= first interval | Bound idle checking cost for slow/failed resources. |
| `backoffFactor` | ratio | 1.5 | finite, >= 1 | Reduce checks while no readiness progress occurs. |
| probe `frames` | count | 3 | integer, >= 1 | Expose asynchronous presentation failures. |
| probe `settleFrameCount` | count | 4 | integer, >= 0 | Allow delayed WebGPU errors after each submit. |
| probe `settleMs` | ms | 75 | finite, >= 0 | Preserve the final presentation-error wait. |

`renderer.frameRateCap` remains a host-owned setting in frames/s; its injected
`minFrameIntervalMs` derives the least time between draws. No extra scheduler
or camera inertia decay is added. Resource identity strings describe the host's
actual backend and device; this initial slice does not infer or certify WebGPU
or WebGL support from those strings.

## Checks and artifact

```sh
npm run ci
npm run check:attribution
```

Run in the assigned checkout after receiving the coordinator's check slot.
Install the recorded development tools and exact peer artifacts first; private
UI `0.1.0` is not claimed available from a registry. Install the exact trusted
`@foss-earth/ci` artifact described by `.attribution-release.json`; the public
conformance entry takes `--consumer . --trusted-release .attribution-release.json
--output-root build/common-conformance`. `ci` runs that gate and then the preserved
implementation chain. `check:attribution` requires the coordinator's complete
intended ref list at `build/repository-split/intended-publication-refs.json`.
That file is pending; do not substitute a partial ref set or skip metadata.
Tests cap workers at 50%. Retain command output under `build/`; no server,
browser, GPU benchmark, or native build is started. `fixtures/consumer.mjs`
loads emitted public exports and shares one fake frame queue with a Babylon
NullEngine adapter. `fixtures/pure-consumer.ts` compiles the pure API using
`ES2022` alone with no DOM library or ambient Node types.

The shared caller/configuration/descriptor pin CI source
`9e046dd482e0229dc7c7b2d71b079d5905664656`, archive
`450ede699f55f9b9c78146eadb73de7c6297e56553e7d7f9e5b164786a7beb24`
and policy `9ca88bf5861685e22e65e5f39fa65b05faaf9c218875fccbecce1b9f2dca5bd3`.
The installed conformance/full-ref gates and actual remote admission remain
pending. `check:implementation` proves implementation behavior only. The shared
workflow has no docs-only skip; no private checker is implemented here.

After building and packing in a reserved slot, run the isolated public consumer
with mandatory `--renderer`, `--ui`, `--babylon`, `--typescript` archive paths and
each corresponding `--name-sha256` argument, using `--name=value` syntax:

```sh
node scripts/check-installed-artifact.mjs --renderer=build/releases/DATE/renderer.tgz --renderer-sha256=EXACT_SHA256 --ui=CHECKED_UI_ARCHIVE --ui-sha256=EXACT_SHA256 --babylon=EXACT_8_56_2_ARCHIVE --babylon-sha256=EXACT_SHA256 --typescript=EXACT_5_9_3_ARCHIVE --typescript-sha256=EXACT_SHA256 --out=build/installed-consumer/DATE
```

These placeholders are pending prerequisites, not release pins. The harness
installs only local exact archives offline with `build/npm-cache`, rejects runtime
and complete declaration source closure outside its workspace, checks strict
public UI mesh-inspector compatibility, poisons pure browser-global access and
peer imports, and retains negative-control evidence. It starts no server or GPU.

## Acceptance limits

This slice extracts backend/scene selection, presentation/readiness, renderer
parameter lifecycle, optional panel/catalogue and generic resource ownership.
It does **not** extract the full `createBabylonRuntime`, map/terrain/camera/Sky
composition or format resource factories. The current source increment adds generic
GPU transfers and profiling below; it is unbuilt and has no new accepted artifact.
Device restoration
is still Babylon's; hosts rebuild feature resources after its event. WebGPU/WebGL
hardware behavior is not qualified by mocked bootstrap or NullEngine tests.
Consumer app adoption, source removal, accepted pins, common CI conformance and
remote admission remain primary/coordinator gates.

Corrections accompany extraction: failed WebGPU initialization releases its
engine, the deprecated engine-only factory disposes the unreturned scene, and
probe engine disposal proceeds if scene disposal throws. Awaiting asynchronous
initialization inside the source try/catch makes its intended WebGL fallback
handle a rejected initialization. Injected ports, these corrections and the
source-file mappings are recorded in provenance.

The current umbrella facade must remain available until downstream consumers
adopt an accepted exact artifact. Rollback restores the facade's source imports
and previous lockfile pin; resources/scheduler must not be duplicated during a
transition. Existing committed-source provenance is recorded in
`extraction-provenance.json`; it does not claim cleaned history acceptance.

## Source-only upload and profiling increment

The 2026-10-09 source increment is unchecked. Previous frozen artifact evidence
does not qualify these additions. Unit/consumer fixtures, declarations and CSS
packaging are prepared for the next reserved check slot; no new supported Node,
browser or GPU environment is claimed.

`createImageTextureUploader` borrows the supplied scene/device and takes one
image or six caller-ordered layers. Representation owners choose that order,
acquire/decode images and reserve source GPU allocations. Each row submission
receives an injected upload ticket from the shared image broker. Tickets must
outlive operation-scope cancellation: reserve them directly from broker pools,
then let renderer release them after queue completion, a GL2 fence/finish, or
observed device loss. GL1 consumes external pixels synchronously. WebGL cropped
strip canvases receive separate decoded/staging grants and are zeroed after
synchronous copies. Partial submission errors retain tickets too. Cube textures
are published only after all six layers and mips have been submitted and their
completion hook is registered. Readiness and display handover stay host-owned.
Call `pump()` only from the existing host frame. Retired-device adapters refuse
further uploads; construct a replacement against the restored authority.

The current source requires
`ImageTextureUploaderOptions.invalidatePublishedSource(failure)`, where public
`ImageUploadCompletionFailure` contains `{error,label,texture}`. The host retires
its cache/source/presentation generation synchronously and may return a promise
for subsequent cleanup. A native completion rejection before publication rejects
and disposes the pending upload. After publication, renderer reports the failure
once for that job and never disposes the texture now owned by its caller. The
callback does not confirm device loss or supply another renderer/broker. A
throwing or rejected host callback is caught so later native completions can
release their grants. `stats().publishedCompletionFailures` counts reports and
`lastPublishedCompletionFailure` retains only the latest record, with
`invalidationError` when its host callback failed. Host fatal/error policy owns
that observation; there is no renderer retry or private observation timer. A
late asynchronous callback error cannot overwrite a newer source failure.
The host checks the failure's actual texture against its owned resource/generation;
a late failure for retired content must not invalidate newer unrelated content.

Unpublished WebGL jobs remain cancellable while final fence creation/flush is
in progress, including synchronous host cancellation at those ports. Cancellation
rejects every pending job but retains already submitted grants until the native
fence/finish establishes completion; only observed context loss releases those
holds early. Neither final handoff nor loss can publish an already failed job.
These causal fixtures are prepared source only and have not run.
Upload/staging admission and canvas/context/binding ports can cancel synchronously.
Pending-state checks after those callbacks prevent subsequent draws/copies into
cancelled ownership; a grant with no native submission releases immediately.

Optional `ImageUploadRequest.textureColor: {useSRGBBuffer,gammaSpace}` sets
storage/material metadata explicitly. Bounded legacy map uploads pass
`{useSRGBBuffer:false,gammaSpace:true}` so the material decodes encoded sRGB,
matching the old map texture flags. Omission preserves existing 360 defaults:
WebGPU sRGB storage/material gamma off; WebGL encoded storage/material gamma
on. Explicit sRGB native storage is not implemented by this WebGL adapter and
is rejected before allocation. RGBA8 format, `invertY=false`, legal mipmaps and
trilinear sampling remain fixed. WebGL1 NPOT skips illegal mips and stays
bilinear; this is not evidence of exact legacy Babylon NPOT resize behavior.
Device maximum side, kind/layer dimensions and color flag types validate before
allocation. U/V clamp remains the uploader default; a legacy map consumer must
preserve any previous wrap/repeat override on the returned `BaseTexture`.

`createTextureTransferTracker({scene,admit,requestRender})` uses that same
backend to track immediate map/raw transfers. `transfer(bytes,label,submit)`
admits before submission; refusal throws before calling `submit`.
`track(ticket,submit)` consumes a grant already admitted by the caller, with no
second broker. Call `pump()` from the same host frame for GL2 fences. Unknown
native completion retains its charge until actual device loss; disposal alone
does not establish that GPU work has finished. Each ticket belongs to one
submission and must not be passed twice.
The tracker owns an admitted ticket before invoking `submit`. If that callback
disposes the tracker while continuing to issue work, GL2 performs a finish only
after `submit` returns. A failed finish keeps the unfinished hold until actual
context loss. A fence/flush port that reenters teardown cannot strand a newly
created fence behind a disposed pump. No timer or replacement device is created.

`fixtures/upload-host.ts` and the guarded installed declaration harness prepare
the required invalidation port using public exports. Current mocks and these
fixtures are unrun. Canonical Earth host wiring and the 360 mock's expanded stats
shape remain primary-owned, and no current artifact/adoption pin is claimed.

`createTextureDevicePorts({scene,transfer})` validates the borrowed scene,
device limits and update metadata, creates raw textures and forwards region,
cube-face and mip updates. `createImageRegionDevicePorts({scene,track})`
creates mutable 2D textures and copies bitmaps/bytes using already-admitted
tickets. Layout, atlas tables, residency and shader conventions remain with
engine/tiled-cubemap. GL pixel/binding state is restored after throwing copies.
Texture disposal always releases the internal allocation even if a Babylon
observer throws. An unreturned allocation is cleaned when transfer tracking
throws after native creation.

`createCanvasTextureDevicePorts({scene,createCanvas,transfer})` supplies an
HTML/Offscreen canvas before `DynamicTexture` allocation. It exposes
`createTexture({name,width,height,mipmaps,samplingMode?})` and
`updateTexture(texture,flipY)`. Updates admit actual canvas width × height × 4
bytes through the supplied tracker, preserve native flip/mip policy and reject
foreign/disposed handles. Hosts/feature owners still account for retained GPU
and canvas allocations. Pixel generation, compass/world geometry and marker
styling are not copied into renderer.

`createPendingImageTexture` is an explicit legacy Babylon `Texture.updateURL`
compatibility adapter. Its acquisition/object-URL ports retain the encoded
body through Babylon load/disposal. Babylon's hidden decode/upload are not
proven charged by this adapter; it is not a claim of common broker conformance.
Hosts must keep that limitation explicit or adopt bounded decoder/uploader
ports before claiming full resource accounting.

Pure `createFrameProfiler({now,...})` preserves rolling summaries, nested
sections, concurrent GPU/background work, percentiles, trace tags/window and
disabled fast paths. `now` is required and is the host monotonic millisecond
clock. Pure `createFrameProfileSession({profiler,measure,canTimeGpuFrames})`
owns only measurement attachment/teardown. The Babylon entry's
`createFrameProfileSession({scene,engine,now})` supplies Babylon phase/GPU
measurements, or accepts the existing `profiler`. Hosts call `session.frame()`
once before work in their one rendered frame. No timer, frame queue or second
device is created. CPU measurements starting at clock zero are retained.

`frameProfilingParameters(home)` preserves the four `renderer.profiling.*`
IDs, units, bounds, defaults and session-only flags. Earth keeps their existing
Renderer → Performance debug home. `bindFrameProfileSettings` takes a
structural `get`/`watch` port satisfied by the host registry. Detach it before
disposing the session. Do not move the existing section into optional Dev.
If a later watch fails during binding, earlier watches are detached. Detach
attempts all acquired watches once; it never disposes the borrowed session or
registry. Stale callbacks cannot reconfigure the session after detach.

`createFrameBudgetPanel` requires `session`, `settings`,
`ui: {document,createParameterControl}`,
`refreshPort: {nowMs,subscribe}`, and `actions: {copy,saveJson,onError?}`.
It gates the existing `renderer.profiling.refreshMs` interval using host refresh
notifications and does no hidden/off refresh work. Clipboard/download policy,
readings, notes and optional visibility are injected. No private panel timer
or implicit application registry is used. `fixtures/profiling-host.ts` shows
the wiring. The Earth's compatibility facade may supply its existing clock,
registry, shared refresh and browser outputs for old optional arguments.

Canonical source removals, current Earth/flight/campus adoption, a rebuilt exact
artifact, refreshed lineage selection, installed shared conformance/full-ref gates
and actual remote admission remain primary/coordinator work.

## Source-only generic diagnostics

`createMeshInspector(scene,{requestRender,whenReady})` preserves selection,
wireframe overlays, hidden readiness and disposal. Its structural handle fits
the public UI `MeshInspectorPanelPort`; the host supplies its own roots and
registers the panel in its existing diagnostic contribution registry.
Renderer owns drawing, and engine owns WGS84 horizon culling and globe geometry.

`createVectorDebugDrawing(scene,parent,options)` preserves arrow/arc geometry,
label cadence and ready-before-reveal behavior. Enabling labels requires the
same host `CanvasTextureDevicePorts`, validated before geometry allocation or
settings mutation. The host calls `update(vectors,timeSeconds,alreadyScheduled)`;
the timestamp is seconds, and this helper creates no clock or frame queue.
Label textures retain original 512 × 80 pixels and bilinear/no-mip sampling.
Native upload and host retained-allocation accounting still require the actual
shared ports and reserved qualification.

`createPerformanceMetrics` requires monotonic milliseconds, memory bytes or
`null`, and host tile/culling observations. `frameSampleCount` is an explicit
positive whole-number host policy, default 120. `update` observes once when the
host requests it; `getSnapshot` and `format` do not poll. Draw calls remain
`null` because this source does not measure them. No partial culling statistics
or hardware benchmark result is invented. Retained source tests and new causal
metrics/startup fixtures are prepared, unrun.

`tests/diagnosticsImportBoundary.test.ts` retains the original positive
"finds the engine where it is loaded" assertion against this owner's actual
diagnostic barrel and `createMeshInspector` source. Its static source scanner
resolves emitted `.js` imports back to `.ts`/`.tsx`; no synthetic heavy module
stands in for the implementation. The original first pure diagnostics assertion
belongs to UI. Vitest now selects both `tests/**/*.test.ts` and the three retained
diagnostics tests under `src/**/*.test.ts`, with source graph paths read from disk
included in `forceRerunTriggers` alongside Vitest's defaults. Selection is prepared
configuration only; no current assertion has been executed or qualified here.

The source-only lifecycle exception repair attempts all still-registered restore
listeners independently, suppresses callbacks removed by an earlier listener or
disposed binding, and attempts one live frame request separately. Errors report
in callback order followed by the request error. A begun frame ends once, and
combined preparation/render and `endFrame` errors retain both failures in that
order. A failed `beginFrame` has no matching `endFrame`; `afterRender` runs only
after successful preparation, render and completion. New causal cases are unrun.


## Source-only completion admission and immutable raw batches

The current `createTextureTransferTracker` returns an additive
`CompletionTextureTransferTracker`. The original structural
`TextureTransferTracker` keeps `transfer`, `track`, `pump`, `deviceLost` and
`dispose`; callers using those ports need no new member. The pure root/core and
Babylon public entries export `TextureTransferOutcome`,
`TextureTransferRetirement`, `TextureTransferAdmission` and
`TryAdmitTextureTransfer` as types without DOM or feature dependencies.

`tryAdmit(bytes,label,retainInput:()=>()=>void)` returns `null` when the complete
upload grant is unavailable, without retaining or copying input. Otherwise it
owns that grant before calling the producer retain port. The returned admission
exposes `active`, `settled`, `retired`, `submit(copy)` and `cancel(reason?)`.
`settled` never rejects: its result is `{status:"uploaded"}` only after proven
completion, `{status:"failed",error}` for copy/cancellation/completion-observer
failure, or `{status:"device-lost"}` after observed loss. A failed/cancelled result
cannot later become uploaded. `active` stays true during a healthy admission,
synchronous copy and native wait; cancellation, a terminal result, disposal or
loss makes it false. The copy callback receives `isActive()` and stops issuing
later regions after reentrant cancellation.

`retired` also never rejects and is separate from publication. Its
`{status:"completed"|"device-lost",cleanupError?}` means no native use remains,
or no work was submitted. Every returned input release and upload-ticket release
is attempted once independently; any errors are recorded in release order. The
host must observe both promises and apply its error policy to `cleanupError`.
Neither cancellation nor ordinary disposal proves GPU completion. In particular,
a rejected or throwing `onSubmittedWorkDone` observation reports failure but
quarantines the original input and upload grants until actual device loss. It
never infers loss from that rejection. Fulfilled completion, a successful GL
fence/finish, or actual observed loss supplies retirement. The legacy immediate
ports use the same tracker; rejected GPU completion now conservatively retains
those legacy grants too. Native/backend behavior remains unqualified.

`createTextureDevicePorts({scene,transfer,tryAdmit?})` preserves structural
`TextureDevicePorts` and adds `RawTextureBatchDevicePorts.prepareRawTextureBatch`.
If the optional completion admission port is absent, a batch request fails
explicitly before native allocation/copy. A `RawTextureBatchRequest` supplies
`{regions,label,retainInput,reserveCopy}`. Each `RawTextureBatchRegion` is
`{texture,data:Uint8Array,x,y,width,height,faceIndex?,lod?,generateMipMaps?}`.
The host already owns each texture. Renderer validates every RGBA8 storage
identity, exact region byte length, coordinate/layer/mip bounds and the total
byte sum before admission. Region order, mip contents, atlas layout, residency
and visible table publication remain entirely with Engine or another feature.

The request's `retainInput()` holds the producer's original pages and returns its
release function. The request's `reserveCopy(bytes,label)` must obtain a separate
decoded/staging memory grant from that same supplied image broker, returning an
`UploadTicket` or throwing capacity refusal. It cannot return `null`. Only after
upload admission, producer retention and copy admission are complete does
Renderer create private `Uint8Array` snapshots. It never detaches caller buffers.
Caller pixel/descriptor mutation after preparation cannot change the captured
native region bytes or order. This is the copying capability; no immutable-borrow
or worker-transfer capability is advertised. Copy admission failure returns an
inactive, failed, unsubmitted batch with independent producer/upload cleanup.

A `PreparedRawTextureBatch` is `{bytes,active,settled,retired,submit(),cancel()}`.
Register the owner's captured generation/slot job before `submit()`. Refuse
`null` or `!active` before issuing native work. Keep submitted slot ownership,
original producer holds and private snapshot charges until `retired`; publish
only a successful `settled` result that is still current. Failure/loss must
invalidate that owner's table/generation. Clearing an atlas must not reuse
submitted slots before retirement. Generic Renderer imports no atlas or page
layout and implements none of that host policy.

WebGL staging cleanup attempts width reset, height reset, both dimension reads
and every ticket release independently. A zero dimension must be observed before
its decoded grant is returned; setter success alone is insufficient. An
unproven canvas remains in a quarantined list with every grant held. Subsequent
strip allocation still requires its own charged admission from the same broker,
so existing capacity bounds that list. Existing host `pump()`/`cancelAll()` may
retry retirement; no timer or scheduler is added. Device loss alone does not
prove a decoded canvas has freed its pixels. Reset during an active canvas or
native copy callback is deferred until the callback returns. Ready peer jobs,
abort detachment, texture disposal, fence deletion and ticket releases are
attempted independently even after another cleanup fails. Reentrant `pump()`
performs no second submission.

Ten admission, ten immutable-batch and six WebGL cleanup causal cases, the actual
public upload-host declaration fixture and installed raw-transfer runtime fixture
are prepared and UNRUN. The installed harness copies these fixtures into its
existing guarded workspace and compiler closure. All previous cases, original
source selections and frozen source553500e/archive2999ee90 remain preserved.
Current source has no accepted artifact, native qualification, app adoption,
complete intended-ref audit or actual remote admission proof. Primary owns
integration and must run the reserved current checks before qualification.


## Source-only work and presentation scheduling

`createRenderScheduler(options)` now returns `WorkRenderScheduler`, extending the
unchanged structural `RenderScheduler` with `requestWork()`. Old mocks and hosts
need no new member. `createBrowserRenderScheduler` returns that same additive
capability over its one existing core scheduler. `RenderSchedulerOptions` adds
optional `work(timeMs)` and `shouldKeepWorking()`; neither adds a clock, timer or
frame authority.

Each requested host RAF prepares work before considering presentation. Work
also runs on requested presentation RAFs, including frames withheld by the
existing presentation interval. `requestWork()` alone never calls `tick()`.
A visible change requested by work may paint once in that same eligible frame;
a request during paint remains for the following frame. Multiple work/render
wakes coalesce. The existing jitter allowance, continuous reference count,
inertial predicate and trailing continuous frame remain presentation behavior.
The frame cap does not delay admitted hidden work.

`shouldKeepWorking()` must describe admitted runnable or in-flight work. It
must be false for capacity-refused resources; their existing native/broker
callback wakes `requestWork()` when they can proceed. The scheduler supplies no
capacity poll. Map older uploader/transfer `requestRender` callback properties
to the host's `requestWork()` for hidden native preparation/fence polling. The
feature owner calls actual `requestRender()` once when ready content changes
visible presentation. Ordinary visible-frame preparation remains host-owned;
Root must remove duplicate hidden pumps when adopting this port.

Pause retires pending frame identity and work wakes before cancellation and
idle notifications; a stale callback cannot clear a newer frame or paint.
Continuous references retain their source pause semantics. Unpause requests
the source's first visible frame, whose work phase uses the current host state.
Stop permanently clears both request flags, continuous references and observers.
All independent cancel/notification actions are attempted, with ordered errors.
Reentrant stop/pause during work prevents old-frame presentation and subsequent
predicates; a newer unpause has its own first frame. Requests during work/paint
are captured without registering a second concurrent RAF. A callback failure
reports after activity cleanup and performs no implicit paint/retry; the host
uses its existing fatal policy or an explicit later wake.

Sixteen new causal scheduler cases and separate actual installed public runtime
and ES2022-only declaration fixtures are prepared and UNRUN. Existing positive
scheduler cases and the prior pure/consumer fixture bytes remain preserved.
Current source has no accepted artifact, app adoption or new check/native
qualification. Canonical composition and rollback remain primary-owned.
