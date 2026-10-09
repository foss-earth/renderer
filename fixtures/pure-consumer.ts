import { createRenderScheduler, createRendererResourceLifecycle, type RendererIdentity, type RenderFrameCallback } from "@foss-earth/renderer/core";

const identity: RendererIdentity = { rendererId: "plain-host", backendId: "host-defined", deviceId: "device-1" };
const frames: RenderFrameCallback[] = [];
const scheduler = createRenderScheduler({ tick() {}, requestFrame(callback) { frames.push(callback); return frames.length; }, cancelFrame() {} });
const owner = createRendererResourceLifecycle({ identity, requestRender: scheduler.requestRender });
owner.adopt(owner.currentGeneration(), { value: { texture: 1 }, dispose() {} });
