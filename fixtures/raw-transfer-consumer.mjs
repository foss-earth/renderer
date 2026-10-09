import assert from "node:assert/strict";
import { Constants } from "@babylonjs/core";
import { createTextureDevicePorts, createTextureTransferTracker } from "@foss-earth/renderer/babylon";

// Installed public ports and causal native mocks only, never hardware qualification.
const native = [], completions = [], events = [];
const engine = {
  isWebGPU: true, getCaps: () => ({ maxTextureSize: 64 }),
  _device: { queue: { onSubmittedWorkDone: () => new Promise((resolve, reject) => completions.push({ resolve, reject })) } },
  updateTextureData(...args) { native.push(args); },
};
const scene = { getEngine: () => engine };
const texture = { getEngine: () => engine, width: 4, height: 4, isCube: false, format: Constants.TEXTUREFORMAT_RGBA, type: Constants.TEXTURETYPE_UNSIGNED_BYTE };
const tracker = createTextureTransferTracker({ scene, admit(bytes) { events.push(["upload", bytes]); return { release() { events.push(["release upload"]); } }; }, requestRender() {} });
const device = createTextureDevicePorts({ scene, transfer: tracker.transfer, tryAdmit: tracker.tryAdmit });
const pixels = new Uint8Array([1, 2, 3, 4]);
const request = {
  regions: [{ texture, data: pixels, x: 0, y: 0, width: 1, height: 1, lod: 0 }, { texture, data: pixels, x: 1, y: 1, width: 1, height: 1, lod: 1 }],
  label: "public feature regions",
  retainInput() { events.push(["retain"]); return () => { events.push(["release input"]); }; },
  reserveCopy(bytes) { events.push(["copy", bytes]); return { release() { events.push(["release copy"]); } }; },
};
const batch = device.prepareRawTextureBatch(request);
assert.ok(batch); assert.equal(batch.active, true); assert.equal(batch.bytes, 8);
assert.deepEqual(events, [["upload", 8], ["retain"], ["copy", 8]]);
pixels.fill(99); batch.submit();
assert.equal(batch.active, true);
assert.deepEqual(native.map(call => [...call[1]]), [[1, 2, 3, 4], [1, 2, 3, 4]]);
assert.deepEqual(native.map(call => call.slice(2)), [[0, 0, 1, 1, 0, 0, false], [1, 1, 1, 1, 0, 1, false]]);
let settled = false; void batch.settled.then(() => { settled = true; });
await Promise.resolve(); assert.equal(settled, false); assert.equal(events.length, 3);
completions[0].resolve(); assert.deepEqual(await batch.settled, { status: "uploaded" });
assert.deepEqual(await batch.retired, { status: "completed" }); assert.equal(batch.active, false);
assert.deepEqual(events.slice(-3), [["release copy"], ["release input"], ["release upload"]]);
const rejectedBatch = device.prepareRawTextureBatch(request); assert.ok(rejectedBatch); rejectedBatch.submit();
const reason = new Error("public native observation rejected"); completions[1].reject(reason);
assert.deepEqual(await rejectedBatch.settled, { status: "failed", error: reason });
const before = events.length; tracker.dispose(); await Promise.resolve(); assert.equal(events.length, before);
tracker.deviceLost(); assert.deepEqual(await rejectedBatch.retired, { status: "device-lost" });
assert.equal(events.length, before + 3);
console.log("Installed public immutable raw batches retain input/copy/upload grants through proven completion or observed loss; native mocks only.");
