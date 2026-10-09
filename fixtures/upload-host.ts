import { createImageTextureUploader, createTextureDevicePorts, createTextureTransferTracker, type ImageTextureUploaderOptions, type ImageUploadCompletionFailure, type RawTextureBatchRequest, type PreparedRawTextureBatch, type TextureDevicePorts, type TextureTransferTracker } from "@foss-earth/renderer/babylon";
import type { TextureTransferAdmission, TextureTransferOutcome, TextureTransferRetirement } from "@foss-earth/renderer";

/** Source-only public wiring. The host already owns its broker/cache and frame. */
export function borrowImageUploader(host: Omit<ImageTextureUploaderOptions, "invalidatePublishedSource"> & {
  sources: { invalidate(failure: ImageUploadCompletionFailure): void | Promise<void> };
}) {
  return createImageTextureUploader({
    scene: host.scene,
    limits: host.limits,
    requestRender: () => host.requestRender(),
    createStagingCanvas: (width, height) => host.createStagingCanvas(width, height),
    // Host decides which generation/presentation to retire. Do not infer actual
    // device loss or destroy the transferred texture inside the renderer job.
    invalidatePublishedSource: failure => host.sources.invalidate(failure),
  });
}

/** Declares actual public batch ports; invoked only by the host's existing frame. */
export function borrowOwnedRawDevice(host: Parameters<typeof createTextureTransferTracker>[0]) {
  const tracker = createTextureTransferTracker({ scene: host.scene, admit: (bytes, label) => host.admit(bytes, label), requestRender: () => host.requestRender() });
  const device = createTextureDevicePorts({ scene: host.scene, transfer: tracker.transfer, tryAdmit: tracker.tryAdmit });
  // Existing structural consumers still receive their original immediate ports.
  const legacyTracker: TextureTransferTracker = tracker;
  const legacyDevice: TextureDevicePorts = device;
  const prepare = (request: RawTextureBatchRequest): PreparedRawTextureBatch | null => device.prepareRawTextureBatch(request);
  return { tracker, device, legacyTracker, legacyDevice, prepare };
}
export function observeOwnedRawBatch(batch: PreparedRawTextureBatch) {
  const active: boolean = batch.active;
  const bytes: number = batch.bytes;
  const settled: Promise<TextureTransferOutcome> = batch.settled;
  const retired: Promise<TextureTransferRetirement> = batch.retired;
  return { active, bytes, settled, retired };
}
export function submitCurrentAdmission(admission: TextureTransferAdmission, submit: () => void) {
  const isCurrent: boolean = admission.active;
  admission.submit(isActive => { if (isCurrent && isActive()) submit(); });
}
