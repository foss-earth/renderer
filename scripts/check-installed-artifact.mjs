import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf("=");
  if (!arg.startsWith("--") || at < 0) throw new Error("Use --name=value arguments.");
  return [arg.slice(2, at), arg.slice(at + 1)];
}));
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const owner = fileURLToPath(new URL("../", import.meta.url));
const ownerBuild = path.join(owner, "build");
const output = path.resolve(args.out ?? path.join(ownerBuild, "installed-consumer", stamp));
const outputRelative = path.relative(ownerBuild, output);
assert.ok(outputRelative && !outputRelative.startsWith("..") && !path.isAbsolute(outputRelative), "Output must remain in this owner's ignored build tree.");
mkdirSync(ownerBuild, { recursive: true });
let existingAncestor = output;
while (!existsSync(existingAncestor)) existingAncestor = path.dirname(existingAncestor);
const buildRealpath = realpathSync(ownerBuild);
const ancestorRealpath = realpathSync(existingAncestor);
assert.ok(ancestorRealpath === buildRealpath || ancestorRealpath.startsWith(buildRealpath + path.sep), "Output ancestor symlink escapes the owner build tree.");
const workspace = path.join(output, "workspace");
mkdirSync(workspace, { recursive: true });
assert.ok(realpathSync(workspace).startsWith(realpathSync(ownerBuild) + path.sep), "Output symlink escapes the owner build tree.");
const environment = { ...process.env };
delete environment.NODE_PATH;
delete environment.NODE_OPTIONS;
delete environment.RENDERER_FORBID_PEERS;
const digests = {};
const dependencies = {};
for (const [argument, name] of [["renderer", "@foss-earth/renderer"], ["ui", "@foss-earth/ui"], ["babylon", "@babylonjs/core"], ["typescript", "typescript"]]) {
  assert.ok(args[argument], `Missing --${argument}`);
  const artifact = path.resolve(args[argument]);
  const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  assert.match(args[`${argument}-sha256`] ?? "", /^[a-f0-9]{64}$/, `Missing exact --${argument}-sha256`);
  assert.equal(sha256, args[`${argument}-sha256`]);
  digests[name] = sha256;
  dependencies[name] = `file:${artifact}`;
}
writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "renderer-installed-fixture", version: "1.0.0", private: true, type: "module", dependencies }, null, 2));
const run = (command, argv, log, options = {}) => {
  const filename = path.join(output, log);
  const fd = openSync(filename, "w");
  let result;
  try { result = spawnSync(command, argv, { cwd: workspace, ...options, env: { ...environment, ...options.env }, stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Installed consumer command failed; inspect ${filename}`);
  return readFileSync(filename, "utf8");
};
run("npm", ["install", "--offline", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", "--cache", path.join(ownerBuild, "npm-cache")], "install.log");
for (const [name, version] of [["@foss-earth/renderer", "0.1.0"], ["@foss-earth/ui", "0.1.0"], ["@babylonjs/core", "8.56.2"], ["typescript", "5.9.3"]]) {
  const metadata = JSON.parse(readFileSync(path.join(workspace, "node_modules", name, "package.json"), "utf8"));
  assert.equal(metadata.name, name);
  assert.equal(metadata.version, version, `Unexpected installed ${name} version`);
}

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
    if (process.env.RENDERER_FORBID_PEERS === "1" && /[/\\\\]node_modules[/\\\\](?:@babylonjs[/\\\\]core|@foss-earth[/\\\\]ui|react(?:-dom)?)(?:[/\\\\]|$)/.test(resolved)) throw new Error("PURE_CORE_IMPORTED_PEER: " + resolved);
  } else if (!result.url.startsWith("node:")) throw new Error("NON_LOCAL_MODULE: " + result.url);
  return result;
}});
`);
writeFileSync(path.join(workspace, "pure.mjs"), `
import assert from "node:assert/strict";
for (const name of ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame"]) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error("PURE_CORE_READ_BROWSER_GLOBAL: " + name); } });
const root = await import("@foss-earth/renderer");
const core = await import("@foss-earth/renderer/core");
const profiling = await import("@foss-earth/renderer/profiling");
assert.equal(root.createRenderScheduler, core.createRenderScheduler);
assert.equal(typeof root.createRendererResourceLifecycle, "function");
assert.equal(typeof root.readRendererPreference, "function");
assert.equal(root.createFrameProfiler, profiling.createFrameProfiler);
let at = 0;
const profiler = profiling.createFrameProfiler({ now: () => at, enabled: true });
const profile = profiling.createFrameProfileSession({ profiler, measure: () => () => {}, canTimeGpuFrames: () => false });
profile.frame(0); profiler.addDuration("render", 3); at = 16; profile.frame();
assert.equal(profiler.summary().measuredMeanMs, 3); profile.dispose();
await assert.rejects(import("@babylonjs/core"), /PURE_CORE_IMPORTED_PEER/);
await assert.rejects(import("@foss-earth/ui/settings"), /PURE_CORE_IMPORTED_PEER/);
console.log("Pure installed root/core loaded with Babylon/UI/React imports and browser global reads forbidden; negative controls rejected.");
`);
writeFileSync(path.join(workspace, "consumer.mjs"), `
import assert from "node:assert/strict";
import { createRenderScheduler } from "@foss-earth/renderer";
import { createBrowserRenderScheduler } from "@foss-earth/renderer/browser";
import { createBabylonRendererLifecycle, whenMeshesReady, createFrameProfileSession, createCanvasTextureDevicePorts, createTextureDevicePorts } from "@foss-earth/renderer/babylon";
import { createRendererPanel, createFrameBudgetPanel } from "@foss-earth/renderer/panel";
import { RENDERER_PARAMETERS, frameProfilingParameters } from "@foss-earth/renderer/settings";
import { createMeshInspector, createVectorDebugDrawing, createPerformanceMetrics } from "@foss-earth/renderer/diagnostics";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { FreeCamera, NullEngine, Scene, Vector3 } from "@babylonjs/core";
assert.equal(typeof createBrowserRenderScheduler, "function");
assert.equal(typeof createRendererPanel, "function");
assert.equal(typeof createFrameBudgetPanel, "function");
assert.equal(typeof createCanvasTextureDevicePorts, "function");
assert.equal(typeof createTextureDevicePorts, "function");
const settings = createSettingsRegistry({ deviceContext: { devicePixelRatio: 2 } });
settings.register([...RENDERER_PARAMETERS, ...frameProfilingParameters({tab: "renderer", section: "performance"})]);
const engine = new NullEngine();
const scene = new Scene(engine);
const inspector = createMeshInspector(scene, { requestRender() {}, whenReady: async () => {} });
const drawingParent = new (await import("@babylonjs/core")).TransformNode("provided-diagnostic-root", scene);
const drawing = createVectorDebugDrawing(scene, drawingParent, { settings: { enabled: false, labels: false, valuePerMeter: 1, maxArrowMeters: 10, labelRefreshHz: 1 }, valueDisplayScale: 1, valueUnit: "units" });
const metrics = createPerformanceMetrics({ engine, scene, now: () => 0, memoryBytes: () => null, getTileMetrics: () => null, getCullingStats: () => ({ total: 0, visible: 0, hidden: 0 }) });
assert.equal(metrics.update().memoryMb, null); assert.equal(inspector.getSnapshot().roots.length, 0);
new FreeCamera("fixture-camera", new Vector3(0, 0, -1), scene);
const scheduler = createRenderScheduler({ tick() {}, requestFrame() { return 1; }, cancelFrame() {} });
const lifecycle = createBabylonRendererLifecycle({ renderer: { mode: "webgl2", requested: "auto", engine }, scene, scheduler, settings,
  platform: { devicePixelRatio: () => 2, isHidden: () => false, onResize: () => () => {}, onVisibilityChange: () => () => {} },
  presentationLayer: 0x10000000, isPreparingFrame: () => false });
try {
  await whenMeshesReady([]);
  lifecycle.renderFrame();
  assert.equal(lifecycle.getDeviceGeneration(), 0);
  const profile = createFrameProfileSession({ scene, engine, now: () => 0 });
  profile.setEnabled(true); profile.frame(0); profile.frame(16);
  assert.equal(profile.profiler.summary().frames, 1); profile.dispose();
  await assert.rejects(import(${JSON.stringify(path.join(output, "outside-control.mjs"))}), /OUTSIDE_ISOLATED_WORKSPACE/);
} finally { drawing.dispose(); drawingParent.dispose(); inspector.dispose(); lifecycle.dispose(); scheduler.stop(); scene.dispose(); engine.dispose(); }
console.log("Installed browser/Babylon/panel/settings exports and supplied-runtime binding passed; outside-workspace negative control rejected.");
`);
writeFileSync(path.join(output, "outside-control.mjs"), "export const shouldNeverLoad = true;\n");
run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), path.join(workspace, "pure.mjs")], "pure-runtime.log", { env: { RENDERER_FORBID_PEERS: "1" } });
run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), path.join(workspace, "consumer.mjs")], "consumer-runtime.log");
writeFileSync(path.join(workspace, "pure.ts"), readFileSync(path.join(owner, "fixtures/pure-consumer.ts")));
writeFileSync(path.join(workspace, "work-scheduler.ts"), readFileSync(path.join(owner, "fixtures/work-scheduler.ts")));
writeFileSync(path.join(workspace, "work-scheduler-consumer.mjs"), readFileSync(path.join(owner, "fixtures/work-scheduler-consumer.mjs")));
run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), path.join(workspace, "work-scheduler-consumer.mjs")], "work-scheduler-runtime.log", { env: { RENDERER_FORBID_PEERS: "1" } });
writeFileSync(path.join(workspace, "upload-host.ts"), readFileSync(path.join(owner, "fixtures/upload-host.ts")));
writeFileSync(path.join(workspace, "raw-transfer-consumer.mjs"), readFileSync(path.join(owner, "fixtures/raw-transfer-consumer.mjs")));
run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), path.join(workspace, "raw-transfer-consumer.mjs")], "raw-transfer-runtime.log");
writeFileSync(path.join(workspace, "public.ts"), `
import { createRenderScheduler, type RendererIdentity } from "@foss-earth/renderer";
import { createBrowserRenderScheduler } from "@foss-earth/renderer/browser";
import { createBabylonRendererLifecycle, createCanvasTextureDevicePorts, createImageTextureUploader, type ImageUploadRequest, type ImageTextureUploaderOptions, type ImageUploadCompletionFailure, type CanvasTextureDevicePorts, type RendererPlatformPort } from "@foss-earth/renderer/babylon";
import { createRendererPanel, createFrameBudgetPanel, type FrameBudgetPanelOptions, type RendererPanelUiPort, type RendererPanelOptions } from "@foss-earth/renderer/panel";
import { RENDERER_PARAMETERS, frameProfilingParameters } from "@foss-earth/renderer/settings";
import { createMeshInspector, createVectorDebugDrawing, createPerformanceMetrics, type VectorDebugDrawingOptions } from "@foss-earth/renderer/diagnostics";
import { createSettingsRegistry, type ParameterSpec } from "@foss-earth/ui/settings";
import type { MeshInspectorPanelPort } from "@foss-earth/ui";
const parameters: readonly ParameterSpec[] = RENDERER_PARAMETERS;
const registry = createSettingsRegistry(); registry.register(parameters);
const identity: RendererIdentity = { rendererId: "fixture", backendId: "actual-host", deviceId: "one-device" };
const platform: RendererPlatformPort = { devicePixelRatio: () => 1, isHidden: () => false, onResize: () => () => {}, onVisibilityChange: () => () => {} };
type Panel = RendererPanelOptions["ui"];
const samePort = (port: RendererPanelUiPort): Panel => port;
const legacyMapColor: NonNullable<ImageUploadRequest["textureColor"]> = { useSRGBBuffer: false, gammaSpace: true };
const budget = (options: FrameBudgetPanelOptions) => createFrameBudgetPanel(options);
const canvas = (options: Parameters<typeof createCanvasTextureDevicePorts>[0]): CanvasTextureDevicePorts => createCanvasTextureDevicePorts(options);
const drawingPorts = (textureDevice: CanvasTextureDevicePorts): Pick<VectorDebugDrawingOptions, "textureDevice"> => ({ textureDevice });
const inspectorPanelPort = (inspector: ReturnType<typeof createMeshInspector>): MeshInspectorPanelPort => inspector;
const uploader = (host: Omit<ImageTextureUploaderOptions, "invalidatePublishedSource"> & { invalidate(failure: ImageUploadCompletionFailure): void | Promise<void> }) => createImageTextureUploader({ ...host, invalidatePublishedSource: failure => host.invalidate(failure) });
const completionFailure = (failure: ImageUploadCompletionFailure) => [failure.error, failure.label, failure.texture, failure.invalidationError];
void [createRenderScheduler, createBrowserRenderScheduler, createBabylonRendererLifecycle, createRendererPanel, identity, platform, samePort, budget, canvas, legacyMapColor, createMeshInspector, createVectorDebugDrawing, createPerformanceMetrics, drawingPorts, inspectorPanelPort, uploader, completionFailure];
`);
const compiler = path.join(workspace, "node_modules", "typescript", "bin", "tsc");
writeFileSync(path.join(workspace, "type-closure.mjs"), `
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
const root = realpathSync(${JSON.stringify(workspace)}) + path.sep;
for (const name of ["pure", "public"]) {
  const filename = path.join(root, "tsconfig." + name + ".json");
  const read = ts.readConfigFile(filename, ts.sys.readFile);
  assert.equal(read.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, {}, filename);
  assert.equal(parsed.errors.length, 0);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const files = program.getSourceFiles().map(source => realpathSync(source.fileName));
  for (const filename of files) {
    assert.ok(filename.startsWith(root), "Declaration closure escaped workspace: " + filename);
    if (name === "pure") assert.ok(!/[/\\\\]node_modules[/\\\\](?:@babylonjs[/\\\\]core|@foss-earth[/\\\\]ui|react(?:-dom)?)(?:[/\\\\]|$)|[/\\\\]lib\\.dom(?:\\.|\\.d\\.ts)/.test(filename), "Pure declaration loaded peer/DOM source: " + filename);
  }
  console.log(JSON.stringify({ name, declarationFiles: files }));
}
`);
for (const [name, libraries, skipLibCheck] of [["pure", ["ES2022"], false], ["public", ["ES2022", "DOM", "DOM.Iterable"], false]]) {
  const config = { compilerOptions: { incremental: true, tsBuildInfoFile: path.join(workspace, "node_modules", ".tmp", `${name}-consumer.tsbuildinfo`), target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: libraries, types: [], strict: true, noEmit: true, skipLibCheck }, include: name === "public" ? ["public.ts", "upload-host.ts"] : ["pure.ts", "work-scheduler.ts"] };
  const filename = path.join(workspace, `tsconfig.${name}.json`);
  writeFileSync(filename, JSON.stringify(config, null, 2));
  const trace = run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), compiler, "-p", filename, "--traceResolution"], `${name}-types.log`);
  for (const match of trace.matchAll(/successfully resolved to '([^']+)'/g)) {
    assert.ok(realpathSync(match[1]).startsWith(realpathSync(workspace) + path.sep), `Type resolution escaped isolated workspace: ${match[1]}`);
  }
}
run(process.execPath, ["--import", path.join(workspace, "guard.mjs"), path.join(workspace, "type-closure.mjs")], "type-closure.log");
const installedPackage = JSON.parse(readFileSync(path.join(workspace, "node_modules", "@foss-earth", "renderer", "package.json"), "utf8"));
const css = path.join(workspace, "node_modules", "@foss-earth", "renderer", installedPackage.exports["./frame-budget.css"]);
assert.match(readFileSync(css, "utf8"), /foss-earth-frame-budget/);
const receipt = { package: "@foss-earth/renderer", version: "0.1.0", artifactSha256: digests["@foss-earth/renderer"], exactArtifactDigests: digests,
  runtime: { node: process.version, platform: process.platform, arch: process.arch }, publicEntries: [".", "./core", "./profiling", "./browser", "./babylon", "./panel", "./settings", "./diagnostics", "./frame-budget.css"],
  checks: ["offline local artifact install", "runtime realpath guard", "outside-workspace negative control", "pure browser-global poisoning and no-Babylon/no-UI/no-React imports with peer negative controls", "NullEngine supplied lifecycle", "installed public immutable raw batch/completion causal mocks", "ES2022-only pure completion declarations", "strict public adapter/panel/settings/UI-mesh-inspector/actual-upload-host declarations and guarded full program closure"],
  limits: ["NullEngine/mocks only; no GPU hardware qualification", "private staging artifacts; no remote admission", "common CI conformance pending"] };
writeFileSync(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ output, receipt }));
