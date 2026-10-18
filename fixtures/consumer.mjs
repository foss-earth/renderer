import assert from "node:assert/strict";
import { createRenderScheduler, createRendererResourceLifecycle } from "@foss-earth/renderer";
import { createSceneUpdates, whenMeshesReady } from "@foss-earth/renderer/babylon";
import { createGoogleTileWorkerClient, installGoogleTilePreparation } from "@foss-earth/renderer/google-preparation";
import { NullEngine, Scene } from "@babylonjs/core";

assert.equal(typeof createGoogleTileWorkerClient, "function");
assert.equal(typeof installGoogleTilePreparation, "function");

// A minimal host consumes emitted ESM through public exports with one queue.
let callback;
let draws = 0;
const scheduler = createRenderScheduler({
  tick() { draws += 1; },
  requestFrame(next) { callback = next; return 1; },
  cancelFrame() { callback = undefined; },
});
const engine = new NullEngine();
const scene = new Scene(engine);
const updates = createSceneUpdates({ scene, requestRender: scheduler.requestRender, isPreparingFrame: () => false });
const resources = createRendererResourceLifecycle({
  identity: { rendererId: "fixture", backendId: "null-fixture", deviceId: "fixture-device" },
  requestRender: scheduler.requestRender,
});
try {
  let disposed = 0;
  const texture = resources.adopt(resources.currentGeneration(), { value: {}, dispose() { disposed += 1; } });
  assert.ok(texture);
  await whenMeshesReady([]);
  assert.equal(await texture.commitVisible(() => undefined), true);
  assert.equal(draws, 0);
  callback(0);
  assert.equal(draws, 1);
  resources.dispose();
  assert.equal(disposed, 1);
} finally {
  resources.dispose();
  updates.dispose();
  scheduler.stop();
  scene.dispose();
  engine.dispose();
}
