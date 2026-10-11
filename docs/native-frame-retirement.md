# Borrowed frame and native retirement contracts

Status: implemented source draft; all new verification is UNRUN.

`@foss-earth/renderer` exports `createBorrowedFrameClosure(options)`,
`createFeatureFramePreparation(ports)`, `createResourceFrameWork(ports)` and
`attemptNativeCleanup(actions, message)`. `BorrowedFrameClosure` supplies
`schedulerOptions(frames)`, `dispose()`, `whenSettled()`, `inFrame` and `disposed`.
A host passes those callbacks to its one scheduler, supplies the real presentation
and Engine/Sky/feature callbacks, and keeps its device alive through settlement.
No Engine, Sky, 360, Scenes or application implementation is imported by Renderer.
The core cancellation type `BorrowedFrameSignal` is structural and needs no DOM
library. Browser/native adapters remain optional entries.

The closure preserves RAF timestamps, one preparation/render/bookkeeping path,
stop-on-error and cleanup after an active frame closes. Resource work uses the
same scheduler without granting an extra paint. `createFeatureFramePreparation`
converts the host's seconds to viewer `dtMs`; only meaningful/current feature
changes request a render. None of these functions constructs a scheduler, device,
clock, broker or feature. `attemptNativeCleanup` attempts every disposer and
reports all failures. Supply actual async owner drains; an empty drain is not
native retirement proof.

`@foss-earth/renderer/babylon` exports:

| Public contract | Ownership and proof |
| --- | --- |
| `createNativeImageResources(NativeImageResourceOptions)` | Borrows scene/device and structural Images broker. Stable device, canvas, region and uploader facades; `resourceWork`, `observedDeviceLoss`, `restoreDevice`, `retire`, compatible `dispose`, `whenSettled`. Engine atlas policy is absent. |
| `createTextureTransferTracker` → `SettledTextureTransferTracker` | Tracks actual submitted input/fence and resource grant; `whenSettled` is additive to existing tracker interfaces. |
| `createImageTextureUploader` → `SettledImageTextureUploader` | Waits queue, submitted native inputs, staging/canvas retirement and async host invalidation. Older structural uploader ports remain valid. |
| `whenBorrowedDeviceSettled({ scene, observeDeviceLoss, onError })` | Final native marker after all parser/decoder owners have drained. WebGPU actual submitted-work completion or observed loss; WebGL1/2 actual `gl.finish()`. |

Abort calls `retire` immediately, before a host awaits settlement or disposes its
device. Cancellation rejects queued results while submitted input/grants stay
held until actual completion. A rejected/missing WebGPU observation does not
prove retirement: the input remains charged until real device loss. The terminal
pump only observes actual native progress; its scheduling interval is not proof.
Device restoration preserves the previous adapter's actual async cleanup drain.
Every cleanup is attempted even if another fails; `whenSettled` retains errors.
A compatible final release callback runs once per supplied function after true
drains and cannot substitute for them.

Call `whenBorrowedDeviceSettled` only after Engine models, Images decoders,
360 resources and all feature work have stopped and settled. A marker taken
earlier cannot cover a later parser upload. If the final marker itself rejects
without observed device loss, settlement remains pending. If loss supplies the
proof, the recorded error is reported before all final releases are attempted.
Neither timers, `Promise.resolve`, worker termination nor forced disposal stands
in for a native proof. Missing third-party retirement evidence is an explicit
pending blocker, not a successful receipt.

Hosts should construct the mutable owner graph synchronously between signal
checks, or explicitly include late/partial startup owners in their failure drain.
Do not attach an already-aborted signal to a cleanup closure and then create
owners after that closure has already completed cleanup. Campus' host `dispose`
releases the borrowed device only after `whenSettled`; abort must begin all owner
retirement earlier. Earth App forwards preserve that ordering and retain partial
Engine startup drains.

Generic frame closure/preparation and native bridges originate in Earth App
`runtimeComposition.ts`, `framePreparation.ts`, `nativeResources.ts`. The existing
Renderer native implementations retain their lineage and licenses; recovery maps
bind original bytes/modes. No author credit was changed or fabricated.

New causal fixtures cover abort during preparation, frame closure/error order,
delayed native input, failed release observers, restoration with old cleanup,
partial startup, rejected GPU observations, actual GL1/2 final-marker boundaries
and release callbacks. These CPU doubles establish contract behavior when run;
they do not establish real GPU/browser performance. `fixtures/native-bindings/`
consumes public emitted exports/types. All new tests and packages remain unrun;
real browser/device and exact archive admission are future gates.
