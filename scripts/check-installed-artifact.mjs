import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf("=");
  if (!arg.startsWith("--") || at < 0) throw new Error("Use --name=value arguments.");
  return [arg.slice(2, at), arg.slice(at + 1)];
}));
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const output = path.resolve(args.out ?? path.join("build", "installed-consumer", stamp));
const workspace = path.join(output, "workspace");
mkdirSync(workspace, { recursive: true });
const digests = {};
const dependencies = {};
for (const [argument, name] of [["renderer", "@foss-earth/renderer"], ["ui", "@foss-earth/ui"], ["babylon", "@babylonjs/core"], ["typescript", "typescript"]]) {
  assert.ok(args[argument], `Missing --${argument}`);
  const artifact = path.resolve(args[argument]);
  const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  if (args[`${argument}-sha256`]) assert.equal(sha256, args[`${argument}-sha256`]);
  digests[name] = sha256;
  dependencies[name] = `file:${artifact}`;
}
writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "renderer-installed-fixture", version: "1.0.0", private: true, type: "module", dependencies }, null, 2));
const run = (command, argv, log, options = {}) => {
  const filename = path.join(output, log);
  const fd = openSync(filename, "w");
  let result;
  try { result = spawnSync(command, argv, { cwd: workspace, ...options, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Installed consumer command failed; inspect ${filename}`);
  return readFileSync(filename, "utf8");
};
run("npm", ["install", "--offline", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", "--cache", path.join(output, "npm-cache")], "install.log");

// Realpath checking rejects symlink escapes as well as bare/relative checkout imports.
writeFileSync(path.join(workspace, "guard.mjs"), `
import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = realpathSync(${JSON.stringify(workspace)}) + path.sep;
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith("file:")) {
    const resolved = realpathSync(fileURLToPath(result.url));
    if (!resolved.startsWith(root)) throw new Error("OUTSIDE_ISOLATED_WORKSPACE: " + resolved);
    if (process.env.RENDERER_FORBID_PEERS === "1" && /[/\\\\]node_modules[/\\\\](?:@babylonjs[/\\\\]core|react(?:-dom)?)(?:[/\\\\]|$)/.test(resolved)) throw new Error("PURE_CORE_IMPORTED_PEER: " + resolved);
  }
  return result;
}});
`);
writeFileSync(path.join(workspace, "pure.mjs"), `
import assert from "node:assert/strict";
import * as root from "@foss-earth/renderer";
import * as core from "@foss-earth/renderer/core";
assert.equal(root.createRenderScheduler, core.createRenderScheduler);
assert.equal(typeof root.createRendererResourceLifecycle, "function");
assert.equal(typeof root.readRendererPreference, "function");
assert.equal(typeof globalThis.window, "undefined");
assert.equal(typeof globalThis.document, "undefined");
console.log("Pure installed root/core loaded with Babylon/React imports forbidden and no DOM globals.");
`);
writeFileSync(path.join(workspace, "consumer.mjs"), `
import assert from "node:assert/strict";
import { createRenderScheduler } from "@foss-earth/renderer";
import { createBrowserRenderScheduler } from "@foss-earth/renderer/browser";
import { createBabylonRendererLifecycle, whenMeshesReady } from "@foss-earth/renderer/babylon";
import { createRendererPanel } from "@foss-earth/renderer/panel";
import { RENDERER_PARAMETERS } from "@foss-earth/renderer/settings";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
assert.equal(typeof createBrowserRenderScheduler, "function");
assert.equal(typeof createRendererPanel, "function");
const settings = createSettingsRegistry({ deviceContext: { devicePixelRatio: 2 } });
settings.register(RENDERER_PARAMETERS);
const engine = new NullEngine();
const scene = new Scene(engine);
new FreeCamera("fixture-camera", new Vector3(0, 0, -1), scene);
const scheduler = createRenderScheduler({ tick() {}, requestFrame() { return 1; }, cancelFrame() {} });
const lifecycle = createBabylonRendererLifecycle({ renderer: { mode: "webgl2", requested: "auto", engine }, scene, scheduler, settings,
  platform: { devicePixelRatio: () => 2, isHidden: () => false, onResize: () => () => {}, onVisibilityChange: () => () => {} },
  presentationLayer: 0x10000000, isPreparingFrame: () => false });
try {
  await whenMeshesReady([]);
  lifecycle.renderFrame();
  assert.equal(lifecycle.getDeviceGeneration(), 0);
  await assert.rejects(import(${JSON.stringify(path.join(output, "outside-control.mjs"))}), /OUTSIDE_ISOLATED_WORKSPACE/);
} finally { lifecycle.dispose(); scheduler.stop(); scene.dispose(); engine.dispose(); }
console.log("Installed browser/Babylon/panel/settings exports and supplied-runtime binding passed; outside-workspace negative control rejected.");
`);
writeFileSync(path.join(output, "outside-control.mjs"), "export const shouldNeverLoad = true;\n");
run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), path.join(workspace, "pure.mjs")], "pure-runtime.log", { env: { ...process.env, RENDERER_FORBID_PEERS: "1" } });
run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), path.join(workspace, "consumer.mjs")], "consumer-runtime.log");
writeFileSync(path.join(workspace, "pure.ts"), readFileSync("fixtures/pure-consumer.ts"));
writeFileSync(path.join(workspace, "public.ts"), `
import { createRenderScheduler, type RendererIdentity } from "@foss-earth/renderer";
import { createBrowserRenderScheduler } from "@foss-earth/renderer/browser";
import { createBabylonRendererLifecycle, type RendererPlatformPort } from "@foss-earth/renderer/babylon";
import { createRendererPanel, type RendererPanelUiPort, type RendererPanelOptions } from "@foss-earth/renderer/panel";
import { RENDERER_PARAMETERS } from "@foss-earth/renderer/settings";
import { createSettingsRegistry, type ParameterSpec } from "@foss-earth/ui/settings";
const parameters: readonly ParameterSpec[] = RENDERER_PARAMETERS;
const registry = createSettingsRegistry(); registry.register(parameters);
const identity: RendererIdentity = { rendererId: "fixture", backendId: "actual-host", deviceId: "one-device" };
const platform: RendererPlatformPort = { devicePixelRatio: () => 1, isHidden: () => false, onResize: () => () => {}, onVisibilityChange: () => () => {} };
type Panel = RendererPanelOptions["ui"];
const samePort = (port: RendererPanelUiPort): Panel => port;
void [createRenderScheduler, createBrowserRenderScheduler, createBabylonRendererLifecycle, createRendererPanel, identity, platform, samePort];
`);
const compiler = path.join(workspace, "node_modules", "typescript", "bin", "tsc");
for (const [name, libraries, skipLibCheck] of [["pure", ["ES2022"], false], ["public", ["ES2022", "DOM", "DOM.Iterable"], true]]) {
  const config = { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: libraries, types: [], strict: true, noEmit: true, skipLibCheck }, include: [`${name}.ts`] };
  const filename = path.join(workspace, `tsconfig.${name}.json`);
  writeFileSync(filename, JSON.stringify(config, null, 2));
  const trace = run(process.execPath, [compiler, "-p", filename, "--traceResolution"], `${name}-types.log`);
  for (const match of trace.matchAll(/successfully resolved to '([^']+)'/g)) {
    assert.ok(path.resolve(match[1]).startsWith(workspace + path.sep), `Type resolution escaped isolated workspace: ${match[1]}`);
  }
}
const receipt = { package: "@foss-earth/renderer", version: "0.1.0", artifactSha256: digests["@foss-earth/renderer"], exactArtifactDigests: digests,
  runtime: { node: process.version, platform: process.platform, arch: process.arch }, publicEntries: [".", "./core", "./browser", "./babylon", "./panel", "./settings"],
  checks: ["offline local artifact install", "runtime realpath guard", "outside-workspace negative control", "pure no-DOM/no-Babylon/no-React import", "NullEngine supplied lifecycle", "ES2022-only pure declarations", "public adapter/panel/settings declarations and guarded resolution"],
  limits: ["NullEngine/mocks only; no GPU hardware qualification", "private staging artifacts; no remote admission", "common CI conformance pending"] };
writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ output, receipt }));
