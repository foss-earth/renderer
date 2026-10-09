import assert from "node:assert/strict";
import { createRenderScheduler } from "@foss-earth/renderer";

// Public installed root and one supplied frame queue; no browser/device clock.
let next = 1, work = 0, paint = 0, publish = false;
const queue = new Map();
const frames = [];
const scheduler = createRenderScheduler({
  work(time) { work++; frames.push(time); if (publish) { publish = false; scheduler.requestRender(); scheduler.requestRender(); } },
  tick() { paint++; }, minFrameIntervalMs: () => 30,
  requestFrame(callback) { const handle = next++; queue.set(handle, callback); return handle; },
  cancelFrame(handle) { queue.delete(handle); },
});
const frame = time => { const callbacks = [...queue.values()]; queue.clear(); callbacks.forEach(callback => callback(time)); };
scheduler.requestWork(); scheduler.requestWork(); assert.equal(queue.size, 1); frame(0);
assert.equal(work, 1); assert.equal(paint, 0); assert.equal(queue.size, 0);
publish = true; scheduler.requestWork(); frame(1);
assert.equal(work, 2); assert.equal(paint, 1); assert.equal(queue.size, 0);
publish = true; scheduler.requestWork(); frame(10);
assert.equal(work, 3); assert.equal(paint, 1); assert.equal(queue.size, 1); frame(31);
assert.equal(work, 4); assert.equal(paint, 2); assert.equal(queue.size, 0);
assert.deepEqual(frames, [0, 1, 10, 31]); scheduler.stop(); scheduler.requestWork(); assert.equal(queue.size, 0);
console.log("Installed public scheduler prepares hidden work and coalesces capped visible publication on one supplied frame queue.");
