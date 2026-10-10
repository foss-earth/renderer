# Babylon shader build support

Renderer owns the generic Babylon shader chunk policy through the optional Node
entry `@foss-earth/renderer/vite`. It exports `babylonShaderChunks()` and
`BABYLON_SHADER_GROUPS`. The root, browser and Babylon runtime entries do not
re-export the build plugin. Its only Vite source import is a type import; emitted
Node code imports neither Vite nor Babylon and reads no browser globals. Importing
the plugin creates no renderer, scene, scheduler, device or map runtime.

This source increment is prepared but **unrun and unqualified**. The prior
qualified Renderer source `ee8954c36626453a7454538d6313024385f4de68` and its
retained archive do not include this export. Consumers need the later checked
artifact/export pins from the owner delivery; version `0.1.0` by itself does not
identify these changed bytes.

```ts
import { defineConfig } from "vite";
import { babylonShaderChunks } from "@foss-earth/renderer/vite";

export default defineConfig({ plugins: [babylonShaderChunks()] });
```

The retained Vite **8.3.4** / Babylon **8.56.2** repair selects two Rolldown
`build.rolldownOptions.output.codeSplitting.groups`:

| Name | Babylon module directory |
| --- | --- |
| `babylon-shaders-glsl` | `@babylonjs/core/Shaders/`, including `ShadersInclude/` |
| `babylon-shaders-wgsl` | `@babylonjs/core/ShadersWGSL/`, including `ShadersInclude/` |

Both slash styles are supported. Materials, engines and host shader directories
are not classified. Babylon root imports register shader modules as side effects;
when that root is reached through a lazy renderer import, grouping avoids one
output chunk for each shader/include. The policy changes chunk placement, not
shader selection or rendering capabilities. A renderer already present in the
initial entry may gain no request-count reduction. A phone entry stays free of
Babylon only when the host's actual import graph keeps the renderer lazy; this
plugin does not move a static renderer import out of that entry.

Hosts with their own chunk groups can compose the exported groups explicitly:

```ts
import { BABYLON_SHADER_GROUPS } from "@foss-earth/renderer/vite";

const codeSplitting = {
  groups: [
    { name: "host-shaders", test: /host-shaders/ },
    ...BABYLON_SHADER_GROUPS,
  ],
};
```

Use either that composed policy or `babylonShaderChunks()` for this output. The
plugin retains the original config hook and does not promise a custom merge
strategy for other host chunk policies. Vite is an exact optional peer; hosts
using this entry supply Vite 8.3.4. Runtime-only Renderer consumers need no Vite.
Other Vite/Rolldown versions, library/SSR outputs and host-specific chunk policies
require their own qualification.

## Prepared causal validation

The source test checks both languages/includes, Windows and POSIX paths, repeated
classification and negative controls for unrelated Babylon/host/phone modules.
The later build/consumer chain must also run these real emitted-module fixtures:

- `npm run test:vite:node` imports the public emitted root/build entries with
  browser globals poisoned and module hooks rejecting Vite/Babylon/browser
  initialization. Positive controls prove the guard is active; importing the
  internal emitted implementation through a private package route must fail.
- `npm run test:vite:types` checks the emitted public declaration with
  `skipLibCheck=false`, including a host-composed grouping policy and a private
  route negative control.
- `npm run test:vite:graph -- <fresh-output-directory>` performs two sequential
  actual Vite production builds of the same phone → lazy Renderer/Babylon graph,
  first without grouping and then with the public plugin. It requires shader
  fragmentation in the baseline, one shader chunk per language after grouping,
  identical actual shader module sets, one physical Babylon provider and no
  renderer/Babylon in either initial phone graph. It retains built chunk bytes,
  SHA256 maps, actual import/module graphs and a portable receipt. It also
  imports each actual emitted lazy facade in Node and checks the `Engine`,
  `OpenPBRMaterial`, `PBRMaterial` and `createSceneUpdates` exports without
  constructing any device or material. A deliberately missing named material
  export must fail Node linking, proving this oracle catches the retained
  failure class rather than only inspecting shader filenames.
  The emitted `ShaderStore` must also contain PBR/OpenPBR registrations in all
  four GLSL/WGSL shader and include dictionaries. Sorted keys and actual shader
  text SHA256 maps must match between baseline and grouped output. This checks
  executed side-effect registrations, including nonempty positive controls;
  a retained zero-rendered module name alone cannot satisfy the proof.

`test:consumer` includes the Node/declaration checks after the normal build.
The two extra graph builds need an explicitly recorded bounded verification
slot; they are not silently included in every unit-test run. The graph fixture
bundles real installed modules, never launches a browser/server or initializes a
GPU. It establishes compiled graph/chunk behavior, not device, network, visual
or performance qualification. Full installed-artifact intake must still prove
every packed byte and strict public route resolves inside the isolated consumer.

## Portable provenance

The source is retained from repository `foss-earth/foss-earth.github.io`, revision
`406e71e7c03317115a7c056548d45926c7d790be`, path
`vite/babylonShaderChunks.ts`, SHA256
`e34ac62f64e69826cbda439dd0268dddcab35d645c6039f765f3b2076942d99d`.
Its group regexes, names and config hook are preserved. Import paths and the
public documentation/fixtures are adapted to this independent owner. The
machine-independent record is [fixtures/vite/provenance.json](../fixtures/vite/provenance.json).
Private original logs/archives remain retained by the primary; they are not
copied into this public contract. Source identity here does not claim remote
publication. The coordinator alone publishes reviewed exact refs/artifacts.

Build attribution/provenance is the separate About owner contract
`@foss-earth/about/vite`; Renderer does not import application Vite helpers,
Flight, Campus, About, CI or Platform implementation. The existing website helper
can be changed to a public re-export by its sole primary after source release.
