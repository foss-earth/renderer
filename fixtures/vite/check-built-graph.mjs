import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { BABYLON_SHADER_GROUPS, babylonShaderChunks } from "@foss-earth/renderer/vite";

// Run only in a separately granted bounded check. Both builds are CPU/Node
// production bundles, never browser/server/device initialization. The argument
// names a fresh evidence directory; existing proof is never overwritten.
assert.ok(process.argv[2], "supply a fresh output directory: npm run test:vite:graph -- <output-root>");
const outputRoot = path.resolve(process.argv[2]);
mkdirSync(outputRoot, { recursive: false });
const fixtureRoot = realpathSync(fileURLToPath(new URL(".", import.meta.url)));
const require = createRequire(import.meta.url);
const manifest = specifier => JSON.parse(readFileSync(require.resolve(specifier + "/package.json"), "utf8"));
const viteVersion = manifest("vite").version;
const babylonVersion = manifest("@babylonjs/core").version;
assert.equal(viteVersion, "8.3.4");
assert.equal(babylonVersion, "8.56.2");
assert.ok(import.meta.resolve("@foss-earth/renderer/vite").endsWith("/dist/vite/index.js"));

// Each language's group, by the module paths it takes; a shader that other code imports statically stays with that code.
const languageGroups = BABYLON_SHADER_GROUPS.filter(group => group.debugName?.startsWith("babylon-shaders-"));
const shaderGroup = id => languageGroups.find(group => group.test.test(id))?.debugName ?? null;
const shaderModules = chunks => [...new Set(chunks.flatMap(chunk => Object.keys(chunk.modules).filter(shaderGroup)))].sort();
const shaderChunks = (chunks, language) => chunks.filter(chunk => Object.keys(chunk.modules).some(id => shaderGroup(id) === language));
const modulePath = id => {
  const normalized = id.replace(/\\/g, "/");
  const marker = normalized.lastIndexOf("/node_modules/");
  if (marker >= 0) return "node_modules/" + normalized.slice(marker + "/node_modules/".length);
  if (path.isAbsolute(id)) return path.relative(fixtureRoot, id).replace(/\\/g, "/");
  return normalized;
};
function closure(chunks, roots) {
  const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const visited = new Set();
  const queue = [...roots];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (visited.has(name)) continue;
    const chunk = byName.get(name);
    assert.ok(chunk, `missing internal chunk ${name}`);
    visited.add(name);
    queue.push(...chunk.imports);
  }
  return [...visited].map(name => byName.get(name));
}
function inspectPhoneGraph(chunks) {
  const phone = chunks.find(chunk => chunk.isEntry && chunk.facadeModuleId?.endsWith("/phone.ts"));
  assert.ok(phone, "must build the actual phone entry");
  assert.ok(phone.dynamicImports.length > 0, "renderer loading must remain dynamic");
  const initial = closure(chunks, [phone.fileName]);
  const initialModules = initial.flatMap(chunk => Object.keys(chunk.modules));
  assert.ok(initialModules.some(id => /\/renderer\/dist\/renderScheduler\.js$/.test(id)), "initial graph must actually exercise the public pure root");
  for (const id of initialModules) {
    assert.ok(!/[\\/]@babylonjs[\\/]core[\\/]/.test(id), `Babylon leaked into initial/phone graph: ${id}`);
    assert.ok(!/\/renderer\/dist\/babylon\//.test(id), `renderer adapter leaked into initial/phone graph: ${id}`);
    assert.ok(!id.endsWith("/renderer.ts"), `lazy renderer became initial: ${id}`);
  }
  const lazy = closure(chunks, phone.dynamicImports);
  const lazyModules = lazy.flatMap(chunk => Object.keys(chunk.modules));
  assert.ok(lazyModules.some(id => /\/renderer\/dist\/babylon\/sceneUpdates\.js$/.test(id)), "lazy graph must exercise the emitted public Babylon adapter");
  assert.ok(lazyModules.some(id => /[\\/]@babylonjs[\\/]core[\\/]Engines[\\/]engine\.js$/.test(id)), "lazy graph must include real Babylon");
  return { initialChunks: initial.map(chunk => chunk.fileName).sort(), lazyChunks: lazy.map(chunk => chunk.fileName).sort() };
}
function registeredShaders(store) {
  const result = {};
  for (const name of ["ShadersStore", "ShadersStoreWGSL", "IncludesShadersStore", "IncludesShadersStoreWGSL"]) {
    const values = store[name];
    assert.ok(values && typeof values === "object", `missing actual shader registry: ${name}`);
    const required = name.startsWith("Includes")
      ? ["pbrUboDeclaration", "openpbrUboDeclaration"]
      : ["pbrVertexShader", "pbrPixelShader", "openpbrVertexShader", "openpbrPixelShader"];
    for (const key of required) {
      assert.ok(typeof values[key] === "string" && values[key].length > 0, `missing actual ${name} registration: ${key}`);
    }
    result[name] = Object.fromEntries(Object.keys(values).sort().map(key => {
      assert.ok(typeof values[key] === "string" && values[key].length > 0, `invalid ${name} shader: ${key}`);
      return [key, { bytes: Buffer.byteLength(values[key]), sha256: createHash("sha256").update(values[key]).digest("hex") }];
    }));
  }
  return result;
}
async function bundle(grouped) {
  const result = await build({
    configFile: false,
    root: fixtureRoot,
    publicDir: false,
    plugins: grouped ? [babylonShaderChunks()] : [],
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: { phone: path.join(fixtureRoot, "phone.ts") },
        output: { entryFileNames: "[name].js", chunkFileNames: "[name]-[hash].js" },
      },
    },
  });
  const files = (Array.isArray(result) ? result : [result]).flatMap(output => output.output);
  const chunks = files.filter(file => file.type === "chunk");
  assert.ok(chunks.length > 0);
  const directory = path.join(outputRoot, grouped ? "grouped" : "baseline");
  mkdirSync(directory);
  for (const file of chunks) {
    const target = path.join(directory, file.fileName);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.code);
  }
  const modules = chunks.map(chunk => ({
    fileName: chunk.fileName,
    bytes: Buffer.byteLength(chunk.code),
    sha256: createHash("sha256").update(chunk.code).digest("hex"),
    imports: chunk.imports,
    dynamicImports: chunk.dynamicImports,
    modules: Object.keys(chunk.modules).map(modulePath).sort(),
  }));
  // Retain the actual built bytes/map before any graph assertion can fail.
  writeFileSync(path.join(directory, "bundle-map.json"), JSON.stringify(modules, null, 2) + "\n");
  const graph = inspectPhoneGraph(chunks);
  // Load actual emitted ESM: the retained defect was a missing named material
  // export, so matching shader paths alone cannot establish a repaired module.
  // The fixture exports constructors but never creates an engine/material/device.
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  const rendererChunk = chunks.find(chunk => chunk.facadeModuleId?.endsWith("/renderer.ts"));
  assert.ok(rendererChunk, "actual lazy renderer facade must remain addressable");
  const materialModule = await import(pathToFileURL(path.join(directory, rendererChunk.fileName)).href);
  for (const name of ["Engine", "OpenPBRMaterial", "PBRMaterial", "ShaderStore", "createSceneUpdates"]) {
    assert.equal(typeof materialModule[name], "function", `actual emitted named export missing: ${name}`);
  }
  const registrations = registeredShaders(materialModule.ShaderStore);
  writeFileSync(path.join(directory, "shader-registrations.json"), JSON.stringify(registrations, null, 2) + "\n");
  // Grouping may eagerly register retained shaders that were individually lazy.
  // Also execute every emitted shader chunk, without constructing a device, to
  // compare the complete retained registries rather than their load order.
  for (const chunk of chunks.filter(chunk => Object.keys(chunk.modules).some(shaderGroup))) {
    await import(pathToFileURL(path.join(directory, chunk.fileName)).href);
  }
  const completeRegistrations = registeredShaders(materialModule.ShaderStore);
  writeFileSync(path.join(directory, "complete-shader-registrations.json"), JSON.stringify(completeRegistrations, null, 2) + "\n");
  return { chunks, graph, modules, materialExports: Object.keys(materialModule).sort(), registrations, completeRegistrations };
}

// Positive failure control demonstrates that real Node linking detects the
// original class of missing named export before any constructor can run.
writeFileSync(path.join(outputRoot, "package.json"), JSON.stringify({ type: "module" }) + "\n");
writeFileSync(path.join(outputRoot, "missing-material.mjs"), "export const Engine = null;\n");
writeFileSync(path.join(outputRoot, "requires-material.mjs"), "import { PBRMaterial } from './missing-material.mjs'; export { PBRMaterial };\n");
await assert.rejects(import(pathToFileURL(path.join(outputRoot, "requires-material.mjs")).href), /does not provide an export named ['"]PBRMaterial['"]/);

const baseline = await bundle(false);
const grouped = await bundle(true);
assert.deepEqual(shaderModules(grouped.chunks), shaderModules(baseline.chunks), "chunk repair must preserve actual retained shader modules");
for (const [store, values] of Object.entries(baseline.registrations)) {
  for (const [key, value] of Object.entries(values)) {
    assert.deepEqual(grouped.registrations[store][key], value, `chunk repair must preserve startup ${store}.${key}`);
  }
}
assert.deepEqual(grouped.completeRegistrations, baseline.completeRegistrations, "chunk repair must preserve complete actual shader registration keys and text");
const store = grouped.chunks.filter(chunk => chunk.name === "babylon-shader-store");
assert.equal(store.length, 1, "the shader store must occupy its own output chunk");
assert.ok(Object.keys(store[0].modules).every(id => /[\\/]Engines[\\/]shaderStore\.js$/.test(id)), "the shader store chunk must hold the store alone");
for (const language of languageGroups.map(group => group.debugName)) {
  const before = shaderChunks(baseline.chunks, language);
  const named = grouped.chunks.filter(chunk => chunk.name === language);
  assert.ok(before.length > 1, `${language} baseline must reproduce the repaired fragmentation`);
  assert.equal(named.length, 1, `${language} must occupy one output chunk`);
  assert.ok(named[0].fileName.startsWith(language + "-"), `${language} must retain the public group name`);
  assert.ok(named[0].imports.includes(store[0].fileName), `${language} must import the store from its own chunk`);
  // The shaders left out are those that other code imports statically; they stay with that code, not in fragments.
  for (const chunk of shaderChunks(grouped.chunks, language).filter(chunk => chunk !== named[0])) {
    assert.ok(Object.keys(chunk.modules).some(id => !shaderGroup(id)), `${language} shaders must not fragment: ${chunk.fileName}`);
  }
  assert.ok(grouped.graph.lazyChunks.includes(named[0].fileName), `${language} must remain reachable through lazy renderer load`);
  assert.ok(!grouped.graph.initialChunks.includes(named[0].fileName), `${language} must remain absent from initial/phone load`);
}
const babylonRoots = new Set(grouped.chunks.flatMap(chunk => Object.keys(chunk.modules))
  .filter(id => /[\\/]@babylonjs[\\/]core[\\/]/.test(id))
  .map(id => realpathSync(id.split("?")[0]).split(path.sep + "@babylonjs" + path.sep + "core" + path.sep)[0]));
assert.equal(babylonRoots.size, 1, "actual graph must use one physical Babylon provider");
const receipt = {
  status: "PASS",
  environment: { node: process.version, vite: viteVersion, babylon: babylonVersion },
  publicEntry: "@foss-earth/renderer/vite",
  shaderModulesPreserved: shaderModules(grouped.chunks).map(modulePath),
  physicalBabylonProviders: babylonRoots.size,
  baseline: { ...baseline.graph, chunks: baseline.modules, materialExports: baseline.materialExports },
  grouped: { ...grouped.graph, chunks: grouped.modules, materialExports: grouped.materialExports },
  actualEmittedMaterialExports: true,
  shaderRegistrations: grouped.registrations,
  actualShaderRegistrationTextPreserved: true,
  missingMaterialExportNegativeControl: true,
  browserExecuted: false,
  rendererInitialized: false,
};
writeFileSync(path.join(outputRoot, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify({ status: receipt.status, receipt: path.join(outputRoot, "receipt.json"), baselineChunks: baseline.modules.length, groupedChunks: grouped.modules.length }));
