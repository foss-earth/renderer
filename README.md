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

Published entries resolve to ESM JavaScript and declarations in `dist/`, with
`.js` imports. `/core` is the same module as the root, so consuming both creates
no second implementation. Babylon is an optional peer; pure consumers need not
install it. The Babylon entry imports backend code but constructs no engine or
scene when loaded. The UI dependency is optional, exact `@foss-earth/ui@0.1.0`,
and type-only in the library's emitted JavaScript. Pure consumers need neither
peer. Tests use the supplied private UI artifact; its receipt is separate from
publication approval.

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
npm run check:implementation
npm pack --ignore-scripts --pack-destination build/releases/2026-10-08
```

Run in the assigned checkout after receiving the coordinator's check slot.
Install the recorded development tools and exact peer artifacts first; private
UI `0.1.0` is not claimed available from a registry. Platform's installer will
own the accepted artifact/closure installation command.
Tests cap workers at 50%. Retain command output under `build/`; no server,
browser, GPU benchmark, or native build is started. `fixtures/consumer.mjs`
loads emitted public exports and shares one fake frame queue with a Babylon
NullEngine adapter. `fixtures/pure-consumer.ts` compiles the pure API using
`ES2022` alone with no DOM library or ambient Node types.

The shared `@foss-earth/ci` policy/workflow/caller pins and installed conformance
command are pending Platform's handoff. `check:implementation` proves only
implementation behavior; it is not metadata admission. No duplicate checker
or workflow is copied here. Docs-only changes must use the same pinned shared
metadata check once the primary owner installs the public caller. No artifact
may be publication-approved until that gate and remote settings are verified.

## Acceptance limits

This slice extracts backend/scene selection, presentation/readiness, renderer
parameter lifecycle, optional panel/catalogue and generic resource ownership.
It does **not** extract the full `createBabylonRuntime`, map/terrain/camera/Sky
composition, generic GPU uploads or format resource factories. Device restoration
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
