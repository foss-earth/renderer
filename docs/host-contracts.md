# Renderer host ports and candidate gates

The application retains one existing renderer/backend/device, one frame
scheduler and one settings registry. This candidate supplies ownership and
scheduling helpers over those authorities; it does not replace the runtime.

## Injected ports

| Port | Units/identity | Host responsibility |
| --- | --- | --- |
| `requestFrame(callback)` / `cancelFrame(handle)` | Callback timestamp: monotonic ms; nonzero integer frame handle | One host frame queue. The source scheduler uses `0` as its no-frame sentinel. |
| `tick()` / `shouldKeepRendering()` | No unit; latter is a boolean | Prepare/render one changed frame. Return true only while host motion/work needs another frame. |
| `minFrameIntervalMs()` | ms; `0` means no cap | Read the current host-owned `renderer.frameRateCap`, in frames/s. |
| `requestRender()` | Visible change request | Supply that scheduler's method to readiness and resource owners. Multiple requests coalesce. |
| `RendererIdentity` | Nonempty `rendererId`, `backendId`, `deviceId` strings | Describe the actual host authority; invalidate before its device/backend changes. No support inference is made from strings. |
| `ResourceDescriptor.dispose` | Actual object ownership | Release the supplied GPU resource once, including provider cancellation if applicable. Do not share disposal ownership. |
| `ResourceDescriptor.whenReady` | Promise completion | Resolve only when the object can draw. No callback declares immediate readiness. A late completion is rejected by token identity. |
| `ReadinessTimers` | Delays in ms | Required for pure polling; Babylon defaults to platform timers only when a wait is started. |
| `ReadinessPolicy` | ms/ms/ratio | Host setting values for adaptive polling, with preserved defaults and explicit bounds in README. |
| Babylon `scene` | `@babylonjs/core@8.56.2` instance | One supplied scene, its existing active camera, readiness cache and mesh/light observables. |
| Babylon `isPreparingFrame()` | Boolean | True from frame preparation start through render, so that frame accounts for its own changes. |
| Bootstrap `RendererBootstrapHost` | Storage/environment ports | Remembered-mode read/save, throwaway canvas, DPR, secure-context/GPU presence, presentation waits and optional reporting. No globals in the selection function. |
| Presentation probe policy | frames/count/ms | Defaults 3/4/75, explicit host-controlled values; no native hardware qualification follows from mock tests. |
| `RendererPlatformPort` | DPR and visibility booleans | Subscribe/unsubscribe resize/visibility events. Source resolution math and hidden-page pause use the same host scheduler. |
| `applyClipping` / `onDeviceLost` | Host callbacks | Engine applies camera clipping; host navigation/features end their own leases. Renderer imports neither implementation. |
| `RendererPanelUiPort` | UI-owned factories/document realm | Choice group/note/check, parameter section, section container and host-section append; registry is supplied explicitly. |
| Diagnostics `textureDevice` | Same borrowed canvas transfer device | Required before enabling vector labels; caller accounts retained canvas/GPU allocations. |
| Diagnostics `update(...,timeSeconds,...)` | Monotonic seconds | Host calls on its existing changed frame; no diagnostic frame queue or clock. |
| Performance `now` / `memoryBytes` | Monotonic ms / bytes or `null` | Host supplies observations; no ambient performance/memory read or poll. |

Generic polling performs no render. The Babylon adapter judges mesh additions
in a microtask, against the last rendered active meshes; a model added and
hidden in one task requests no frame. Meshes/materials and camera post-processes
that the last frame could not draw settle without drawing, then request once.
Host frame start calls `cancelSettle`; host idle after a rendered frame calls
`settle`. Pause/disposal should cancel outstanding settle work. The host wires
this lifecycle once; the adapter subscribes to no global scheduler itself.

Scheduler `stop()` permanently retires its frame authority, clears continuous
holders and detaches activity listeners even if a supplied cancel/notification
callback throws. All observers of a transition are attempted; a synchronous
newer transition supersedes the older notification snapshot. The host chooses
its frame-error policy. Earth's prepared host fixture stops before reporting a
fatal frame error and requires explicit session recreation for recovery.
Two causal stop/reentrancy fixtures are prepared and unrun.

`whenMeshesReady` retains source treatment of disposed or irrecoverably
compile-failed meshes as settled. This is not a promise that a failed material
became drawable. Babylon owns the error reporting. A pending texture without
a terminal readiness signal continues adaptive checking until cancelled.

## Platform CI/installer fixture requirements

- Package identity: `@foss-earth/renderer@0.1.0`; public exports: `.`, `./core`,
  `./profiling`, `./browser`, `./babylon`, `./panel`, `./settings`,
  `./diagnostics`, `./frame-budget.css`, `./package.json`; ESM/declarations.
- Runtime closure: zero required npm dependencies; the optional Babylon
  adapter has exact peer `@babylonjs/core@8.56.2`. It must reuse the host's copy.
  Optional panel/catalogue types use public `@foss-earth/ui@0.1.0`;
  the renderer JavaScript imports none of its implementation. Current tests
  require a new checked private UI archive including its pure
  `MeshInspectorPanelPort`; no current archive is accepted for this increment.
  Earlier foundation archive evidence remains immutable and applies only to
  that earlier source. Never resolve sibling source paths in installed checks.
- Build tooling pins are recorded in `package.json`. Installer check commands
  must be argv arrays and require no server, GPU, benchmark or native build.
- `npm run check:implementation` runs typecheck/lint/unit tests/build/public
  consumer fixtures; tests use Node and a Babylon NullEngine, with workers
  capped at 50%. Check ownership remains coordinator-reserved.
- Pure consumer fixture has `lib: ["ES2022"]` and `types: []`; core declaration
  loading must not require DOM, React or Babylon. Runtime import in Node must
  start no timer or device initialization.
- `extraction-provenance.json` records committed source `90e23b3...` and exact
  blob/content/destination mappings. Source lineage cleanup/admission is a
  separate coordinator operation; a directory copy is not history acceptance.
- Actual shared caller/configuration/descriptor pin CI source
  `9e046dd482e0229dc7c7b2d71b079d5905664656`, archive
  `450ede699f55f9b9c78146eadb73de7c6297e56553e7d7f9e5b164786a7beb24`
  and policy `9ca88bf5861685e22e65e5f39fa65b05faaf9c218875fccbecce1b9f2dca5bd3`.
  `check:conformance` calls only the installed shared component with actual
  `--consumer . --trusted-release .attribution-release.json --output-root
  build/common-conformance` pairs. `ci` invokes conformance, then the preserved
  `check:implementation`. `check:attribution` requires a complete intended ref
  list; that input and installed gate receipts remain pending. The workflow
  includes docs-only changes. No copied validator or remote admission claim.

## Remaining behavior extraction

| Area | This candidate | Required next owner work |
| --- | --- | --- |
| Scheduling/readiness | Source behavior retained, ports explicit | Primary facade adoption; host wiring with one existing scheduler. |
| Generic resource lifetime | Host identity + opaque generations, stale disposal, hidden readiness and visible commit | Adapt existing runtime factories and provider cancellation to these ports. |
| Backend/device/scene creation | Source preference/normal/safe probe/fallback and scene defaults extracted; supplied-runtime context-loss/restoration events | Primary replaces its bootstrap/facade and adapts feature rebuilds. Babylon still owns actual device restoration. Hardware paths remain unqualified by unit tests. |
| GPU upload APIs | Source-only row uploader, raw/region/canvas device ports and completion tracker | Reserved unit/installed checks and actual artifact needed; host supplies one broker, staging/canvas realm and frame pump. Representation acquisition/format structures stay with owners. |
| Frame profiling | Source-only pure profiler/session, Babylon measurements, parameters and frame-budget presentation | Host supplies clock, one frame boundary, registry/UI, shared refresh and output policy; source checks still pending. |
| Generic diagnostics | Source-only mesh inspector/vector drawing and clock/memory performance observations; original assertions retained | Supply roots/canvas/feature observations and optional host-owned panel contribution. Draw-call measurement remains unavailable; no feature culling algorithm belongs here. |
| Renderer panel/settings | Source panel and catalogue extracted; UI factory/registry/document ports explicit | Primary supplies public UI helper adapter, registers each feature once, and supplies engine clipping callback. Renderer exposure/fill remain Sky-owned. |
| Consumer adoption/rollback | Fixture only | Accepted exact package artifact, current Earth and downstream receipts; keep existing facade until adoption. |

The current source files remain untouched. A rollback of this candidate's
adoption switches the facade back to previous imports/pins without starting a
second runtime. Existing source behavior remains available until the owning
primary makes the integrated transition.

## UI panel adapter and catalogue ownership

The host passes `{ document, isInput, createChoiceGroup, createChoiceNote,
checkChoice, createParameterSection, createSectionsElement, appendHostSections }`
from its single public UI implementation. `isInput` uses the injected document's
input-element realm. Wrap parameter-section/host-section factories to supply the
host's required shared refresh and panel context to current UI. Do not depend on
an implicit UI timer. Bind any receiver-dependent method. No helper body is
copied here; actual current UI bridge qualification is pending its new artifact.
`createRendererPanel` retains backend selection/reload note/fallback diagnostics,
`renderer.backend` coverage, source section IDs and host section contributions.

`RENDERER_PARAMETERS` retains six source IDs/homes. `RENDERER_EXPERIMENT_PARAMETERS`
is an exact legacy compatibility catalogue; `RENDERER_OWNED_EXPERIMENT_PARAMETERS`
contains only `all` and `presentationCandidates`. The three panorama records
are exposed as `LEGACY_360_RENDERER_PARAMETER_HANDOFF` for 360 to own/register
once. No runtime panorama code is imported and no extra setting home is created.
Source `appSettings.ts` connects `renderer.experiments.all` to the four other
IDs using UI's `linkParameterGroup`. Host composition must retain that same
single group link after all owner records are registered. It is composition,
not another parameter registry or a branch on a preset's name. Supply the
registry's actual DPR in its initial device context so the safe bootstrap's
resolution default still resolves to one drawn pixel per CSS pixel.

On loss the lifecycle calls host lease teardown before resource invalidation
and feature subscribers. GPU submissions hold direct broker grants through
scope cancellation; `deviceLost` means observed backend/context loss, never a
shortcut for an operation abort. Retire/recreate uploader and transfer adapters
with that authority. Legacy pending `Texture.updateURL` explicitly does not
establish shared decode/upload accounting; retain that compatibility limit.

`ImageTextureUploaderOptions.invalidatePublishedSource` is required by the current
source. Its public `ImageUploadCompletionFailure` is `{error,label,texture}`; the
host synchronously retires its cache/source/presentation generation and may return
`Promise<void>` for additional cleanup. Rejected native completion after texture
publication reports once per job through this port, without disposing transferred
caller ownership or asserting device loss. Pending jobs still reject and dispose
their untransferred texture. The callback may throw/reject: renderer catches that
failure and records the latest `invalidationError` in
`stats().lastPublishedCompletionFailure`, with a cumulative
`publishedCompletionFailures` count. This bounded record is observation for the
existing host fatal/error policy; no retry, timer or implicit invalidation is added.
An older asynchronous host rejection cannot overwrite a newer source record.
The host checks the reported texture's ownership/generation before retiring
content, so a retired source's late callback cannot invalidate newer content.

All unpublished GL jobs stay visible to `cancelAll` through final fence/flush.
Operation cancellation retains native submission tickets; confirmed context loss
can release them. Immediate transfer tracking owns a grant before `submit`, and
GL2 finishes after a submit that reenters disposal returns. Failed completion
queries/finish preserve unknown-completion charges until observed loss. Supplied
native ports, broker admission and request-render callbacks retain their existing
authority and exception responsibilities. Throwing/rejected invalidation callbacks
are explicitly contained and require host reporting/retirement repair.

Profiling source contracts and the prepared installed harness are documented
in README's source-only increment. The immutable source culling geometry is
engine-owned, as are sprites, marker atlas pixel generation and orbit-compass
geometry. Renderer only accepts their supplied pixel/backend transfer ports.
Site content, icons, examples and application branding remain host-owned.

Startup failure disposes acquired candidates/observers/subscriptions, including
partial scene-update registration. Every acquired stop is attempted once even
after another throws. Detached callbacks are inert. Neither rollback nor final
detach destroys the borrowed scene/device/scheduler/registry/profile session.
Already applied resolution/device context/settings remain host state; this is
binding cleanup, not transactional rollback of host settings. A provider that
throws after internally acquiring a subscription without returning its stop must
perform its own rollback; Renderer cannot discover that hidden handle.

The diagnostics, current upload/profiling source and seven new partial-startup/
all-stop causal fixtures are unrun. Previous frozen renderer source
`553500e53481873711e103dcf2820546e7655061` and archive
`2999ee902bedce13083f12a0501a36afd601bbf8322fd1ae42f5afdf84452203`
remain previous evidence only. The expanded selected original paths require
primary lineage integration before any actual full-ref audit or new artifact.

YOU CANNOT HAVE AI AS A CO-AUTHOR, OR YOUR CONTRIBUTIONS WILL BE REJECTED.

Restore subscribers run independently over a membership-checked snapshot; removed
or disposed subscribers are skipped. One live frame request is attempted separately
and errors are reported in listener/request order. A successfully begun frame ends
once even when preparation/render throws. A second `endFrame` failure is aggregated
after the primary failure; a single failure preserves its identity. `afterRender`
runs only after preparation, scene render and end all succeed. A failed begin has
no matching end. These source-only causal fixtures remain unrun; the host owns the
fatal policy and borrowed device/scene/scheduler lifetime.


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
