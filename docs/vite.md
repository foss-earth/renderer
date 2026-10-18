# Babylon build support

Renderer owns the generic Babylon build policies through the optional Node
entry `@foss-earth/renderer/vite`. It exports `babylonShaderChunks()` and
`BABYLON_SHADER_GROUPS`, and `babylonBarrels()` and `BABYLON_BARREL`, which keep
[only the Babylon modules used](#only-the-babylon-modules-used). The root, browser
and Babylon runtime entries do not re-export the build plugins. Their only Vite
source imports are type imports; emitted Node code imports neither Vite nor
Babylon and reads no browser globals. Importing the plugins creates no renderer,
scene, scheduler, device or map runtime.

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

With Vite **8.3.4** and Babylon **8.56.2**, the plugin sets four Rolldown
`build.rolldownOptions.output.codeSplitting.groups`, tried in this order:

| Name | Modules | Loads |
| --- | --- | --- |
| `babylon-shader-store` | `@babylonjs/core/Engines/shaderStore.js` | with Babylon |
| `babylon-shaders-static` | shaders and includes in `Shaders/` or `ShadersWGSL/` that code outside those folders imports statically, directly or through other shaders | with Babylon |
| `babylon-shaders-glsl` | the rest of `Shaders/`, including `ShadersInclude/` | the first time a material imports a GLSL shader |
| `babylon-shaders-wgsl` | the rest of `ShadersWGSL/`, including `ShadersInclude/` | the first time a material imports a WGSL shader |

Babylon's materials import their shaders with `import()`, for the language the
engine compiles, so a page on WebGPU never fetches the GLSL chunk and a page on
WebGL never fetches the WGSL one (optimization backlog S4). The other two groups
keep it that way:

- The store that every shader registers in gets a chunk of its own. The code that
  compiles shaders imports it too, and with the store in a language's chunk,
  loading Babylon would load that language.
- A few Babylon modules import shaders statically, such as the WebGPU clear quad,
  the effect renderer's `postprocess.vertex` and the WGSL shader processor's
  includes, and so may a host. Those shaders load with that code. They share one
  chunk, since other shaders import some of them too, and each would otherwise
  get a chunk of its own.

Babylon's index files do not count as static importers. With `babylonBarrels()`
the build leaves them out; without it they import every shader, and each
language's chunk loads with Babylon, as before the split. Each shader group sets
`includeDependenciesRecursively: false`, since a shader's imports, the store and
other shaders, each have their own group. Both slash styles are supported.
Materials, engines and host shader directories are not classified. The policy
changes chunk placement, not shader selection or rendering capabilities. A phone
entry stays free of Babylon only when the host's actual import graph keeps the
renderer lazy; this plugin does not move a static renderer import out of that
entry.

Each built page whose code can reach a language's chunk names it in the head:

```html
<script type="application/json" id="babylon-shader-chunks">{"glsl":"/app/assets/babylon-shaders-glsl-….js","wgsl":"/app/assets/babylon-shaders-wgsl-….js"}</script>
```

URLs follow the build's base, absolute or relative to the page. The dev server
adds nothing.

A page whose code can reach the WGSL chunk can draw with WebGPU, so its first
script, right after `<meta charset>`, asks for a WebGPU adapter, unless WebGL is
saved as this browser's fallback (`foss-earth:renderer-fallback`). It keeps the
answer in `window.__fossEarthWebGpuSupport` as a promise of whether an adapter
came. A browser's first adapter took 36–83 ms to come in fresh headless Chrome
profiles, and the next ones 0.2–35 ms, so the first comes while the page's
modules load. The browser host takes the promise once, in place of
`WebGPUEngine.IsSupportedAsync`, which asks the same; Babylon's own request,
when the engine starts, is then a later one. A page without the script, or a
host without the `earlyWebGpuSupport` port, asks when the renderer starts.

The renderer's bootstrap calls the host port `preloadShaders(language)` as soon
as it knows the language: `"wgsl"` once the browser offers a WebGPU adapter,
`"glsl"` when it creates a WebGL engine. The browser host adds a
`<link rel="modulepreload" crossorigin data-shaders="…">` for that URL, so the
chunk downloads while the engine starts instead of when the first material
compiles. A page without the element, or a host without the port, loads the
chunk on first use as before.

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
  fragmentation in the baseline and, after grouping, one `babylon-shader-store`
  chunk holding only the store, and for each language one chunk named after it
  that imports the store and is in the lazy graph but not the initial one, with
  every other chunk holding that language's shaders named
  `babylon-shaders-static`. It also requires identical actual shader module sets, one physical Babylon provider and no
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
Its config hook and the two language group names are preserved; the store and static groups, the page element and the preload were added here for S4. Import paths and the
public documentation/fixtures are adapted to this independent owner. The
machine-independent record is [fixtures/vite/provenance.json](../fixtures/vite/provenance.json).
Private original logs/archives remain retained by the primary; they are not
copied into this public contract. Source identity here does not claim remote
publication. The coordinator alone publishes reviewed exact refs/artifacts.

Build attribution/provenance is the separate About owner contract
`@foss-earth/about/vite`; Renderer does not import application Vite helpers,
Flight, Campus, About, CI or Platform implementation. The existing website helper
can be changed to a public re-export by its sole primary after source release.

## Only the Babylon modules used

`babylonBarrels()` lets a production build keep only the Babylon modules an
application uses.

```ts
import { defineConfig } from "vite";
import { babylonBarrels, babylonShaderChunks } from "@foss-earth/renderer/vite";

export default defineConfig({ plugins: [babylonBarrels(), babylonShaderChunks()] });
```

Babylon 8.56.2 declares every file as having side effects
(`"sideEffects": ["**/*", …]`), its index files too, so one name imported from
`@babylonjs/core` keeps the whole library: both shader languages, every
material, audio, physics and the flow graph. The index files only re-export. Counted free of side effects
(`BABYLON_BARREL` matches them), a name brings the module that defines it and
that module's own imports, and nothing else. The JavaScript the FOSS Earth app
loads at start went from 69 files and 1.83 MiB compressed (7.5 MiB minified) to
42 files and 1.10 MiB (4.1 MiB); the tour's campus pages went the same way, and
0sfs's flight, which loads Babylon later, from 82 files and 2.12 MiB to 64 and
1.43 MiB (October 2026). Only core's index files are counted: a loader's index
registers the loader, and `import "@babylonjs/loaders/glTF"` is written for that
alone. Only `vite build` uses the plugin; the dev server serves Babylon whole.

What the modules left out did as side effects is then missing. Babylon's index
imports modules that add methods to its classes, or register shaders and other
things by name; a module that relies on one imports it itself, as
[Babylon's guide to ES6 imports](https://doc.babylonjs.com/setup/frameworkPackages/es6Support)
says. The FOSS Earth packages import these:

| Module | Imported by | For |
| --- | --- | --- |
| `Engines/WebGPU/Extensions/engine.dynamicTexture.js` | Renderer, `src/babylon/recoverableWebGpuEngine.ts` | `createDynamicTexture` and `updateDynamicTexture` on the WebGPU engine, which `DynamicTexture` (text labels) calls. `DynamicTexture` imports only the WebGL engine's. |
| `Engines/Extensions/engine.query.js` | Renderer, `src/babylon/frameProfiler.ts` | The WebGL engine's GPU frame timer, which `EngineInstrumentation` calls when frame time is measured. The WebGPU engine has its own. |
| `Rendering/edgesRenderer.js` | Engine, `src/visualization/orbitCompass.ts` | `enableEdgesRendering`, which draws the orbit compass's lines. |
| `Collisions/collisionCoordinator.js` | Engine, `src/babylon/globeCamera.ts` | The collision coordinator, which the globe camera uses on every move once `checkCollisions` is on. |

A missing one shows in a production build only, in one of three ways:

- Most methods added this way have a stand-in that throws and names the module:
  "EdgesRenderer needs to be imported before as it contains a side-effect
  required by your code."
- Some have none, and the call fails with "… is not a function", as
  `createDynamicTexture` did on WebGPU.
- A shader or shader include that nothing registered is fetched from the page's
  `src/Shaders/` or `src/ShadersWGSL/` as a `.fx` file, which our sites answer
  with 404.

Babylon's offline store (`Offline/database.js`) is left out too, since only the
index imports it. It does nothing unless `Database.IDBStorageEnabled` is set,
which our code does not do; our sites keep their files with their own service
worker. An application that turns it on imports the module itself.

The modules were checked by building each application with and without the
plugin, importing each build's Babylon modules in Node, and comparing every
Babylon class's own and prototype members and their source. With the four
imports above, the app's build with the plugin still lacks 133 members that the
build without it has, and keeps 18 as stand-ins. Our code reaches none of them:
they are not called, or only after a check that they exist, or only by Babylon
features we do not use: views, the loading screen of `SceneLoader.Append`,
physics, reading `.babylon` files, screenshots and multiview. The tour lacks the
same members and 0sfs two fewer. Some failures wait for the visitor: without the
collision coordinator the globe camera fails on its first move, not before.
After a Babylon upgrade, or when code starts using a Babylon feature, run the
production build in a browser on WebGPU and on WebGL 2, and move the camera.
