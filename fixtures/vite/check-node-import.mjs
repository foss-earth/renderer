import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Observe real emitted ESM imports. A type-only Vite dependency cannot become a
// runtime import, and Node build support must never initialize browser/Babylon.
const seen = [];
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "vite" || specifier.startsWith("@babylonjs/")
      || /^@foss-earth\/renderer\/(?:babylon|browser|panel|diagnostics)(?:\/|$)/.test(specifier)) {
      throw new Error(`FORBIDDEN_BUILD_IMPORT: ${specifier}`);
    }
    const resolved = nextResolve(specifier, context);
    seen.push(resolved.url);
    if (/\/renderer\/dist\/(?:babylon|panel)\//.test(resolved.url)
      || /\/renderer\/dist\/browser\.js$/.test(resolved.url)) {
      throw new Error(`FORBIDDEN_BUILD_MODULE: ${resolved.url}`);
    }
    return resolved;
  },
});
const saved = new Map();
for (const name of ["window", "document", "navigator"]) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() { throw new Error(`FORBIDDEN_BROWSER_ACCESS: ${name}`); },
  });
}
try {
  const root = await import("@foss-earth/renderer");
  const vite = await import("@foss-earth/renderer/vite");
  assert.equal(typeof root.createRenderScheduler, "function");
  assert.equal(vite.babylonShaderChunks().name, "foss-earth-babylon-shader-chunks");
  assert.equal(vite.BABYLON_SHADER_GROUPS.length, 2);
  assert.ok(seen.some(url => url.endsWith("/dist/vite/index.js")), "must load the emitted public entry");
  assert.ok(seen.every(url => !url.includes("/renderer/src/") && !/\.tsx?$/.test(url)), "must not borrow TypeScript implementation source");
  // Positive controls prove the resolution guard is active without evaluating a
  // Babylon or Vite implementation.
  await assert.rejects(import("@babylonjs/core"), /FORBIDDEN_BUILD_IMPORT/);
  await assert.rejects(import("vite"), /FORBIDDEN_BUILD_IMPORT/);
  await assert.rejects(import("@foss-earth/renderer/dist/vite/babylonShaderChunks.js"), error => error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED");
  console.log(JSON.stringify({ status: "PASS", emittedModules: seen, browserAccess: 0 }));
} finally {
  hooks.deregister();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
