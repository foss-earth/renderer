import { createRenderScheduler, createRendererResourceLifecycle, type RendererIdentity, type RenderFrameCallback } from "@foss-earth/renderer/core";
import { createFrameProfiler, createFrameProfileSession, FRAME_PROFILING_IDS } from "@foss-earth/renderer/profiling";
import type { TextureTransferAdmission, TextureTransferOutcome, TextureTransferRetirement, TryAdmitTextureTransfer } from "@foss-earth/renderer";

const identity: RendererIdentity = { rendererId: "plain-host", backendId: "host-defined", deviceId: "device-1" };
const frames: RenderFrameCallback[] = [];
const scheduler = createRenderScheduler({ tick() {}, requestFrame(callback) { frames.push(callback); return frames.length; }, cancelFrame() {} });
const owner = createRendererResourceLifecycle({ identity, requestRender: scheduler.requestRender });
owner.adopt(owner.currentGeneration(), { value: { texture: 1 }, dispose() {} });
const profiler = createFrameProfiler({ now: () => 0 });
const profile = createFrameProfileSession({ profiler, measure: () => () => {}, canTimeGpuFrames: () => false });
profile.frame(0);
profile.dispose();
void FRAME_PROFILING_IDS;
const completion = (admission: TextureTransferAdmission): [boolean, Promise<TextureTransferOutcome>, Promise<TextureTransferRetirement>] => [admission.active, admission.settled, admission.retired];
const retainProducer = (tryAdmit: TryAdmitTextureTransfer, retain: () => () => void) => tryAdmit(16, "host-owned pixels", retain);
void [completion, retainProducer];
