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

Generic polling performs no render. The Babylon adapter judges mesh additions
in a microtask, against the last rendered active meshes; a model added and
hidden in one task requests no frame. Meshes/materials and camera post-processes
that the last frame could not draw settle without drawing, then request once.
Host frame start calls `cancelSettle`; host idle after a rendered frame calls
`settle`. Pause/disposal should cancel outstanding settle work. The host wires
this lifecycle once; the adapter subscribes to no global scheduler itself.

`whenMeshesReady` retains source treatment of disposed or irrecoverably
compile-failed meshes as settled. This is not a promise that a failed material
became drawable. Babylon owns the error reporting. A pending texture without
a terminal readiness signal continues adaptive checking until cancelled.

## Platform CI/installer fixture requirements

- Package identity: `@foss-earth/renderer@0.1.0`; public exports: `.`, `./core`,
  `./browser`, `./babylon`, `./panel`, `./settings`, `./package.json`; ESM/declarations.
- Runtime closure: zero required npm dependencies; the optional Babylon
  adapter has exact peer `@babylonjs/core@8.56.2`. It must reuse the host's copy.
  Optional panel/catalogue types use public `@foss-earth/ui@0.1.0`;
  the renderer JavaScript imports none of its implementation. Tests install the
  verified private UI public archive, not sibling source paths.
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
- No common CI workflow/caller/policy pins have been installed yet. Platform
  must supply one pinned public checker/conformance command; the primary owns
  its caller installation. Metadata runs include docs-only changes and full
  selected publication refs. Remote admission remains unverified.

## Remaining behavior extraction

| Area | This candidate | Required next owner work |
| --- | --- | --- |
| Scheduling/readiness | Source behavior retained, ports explicit | Primary facade adoption; host wiring with one existing scheduler. |
| Generic resource lifetime | Host identity + opaque generations, stale disposal, hidden readiness and visible commit | Adapt existing runtime factories and provider cancellation to these ports. |
| Backend/device/scene creation | Source preference/normal/safe probe/fallback and scene defaults extracted; supplied-runtime context-loss/restoration events | Primary replaces its bootstrap/facade and adapts feature rebuilds. Babylon still owns actual device restoration. Hardware paths remain unqualified by unit tests. |
| GPU upload APIs | Not extracted | Expose generic uploads; representation-owned acquisition/format structures stay with their owners and images owns budgets. |
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
input-element realm. The other functions match the source UI helpers' public
shapes; bind any receiver-dependent method. No helper body is copied here.
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

YOU CANNOT HAVE AI AS A CO-AUTHOR, OR YOUR CONTRIBUTIONS WILL BE REJECTED.
