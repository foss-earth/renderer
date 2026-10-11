import { createBorrowedFrameClosure, createFeatureFramePreparation, createResourceFrameWork, type BorrowedFrameClosureOptions, type BorrowedFrameSignal, type RenderSchedulerOptions } from "@foss-earth/renderer";
import { createNativeImageResources, whenBorrowedDeviceSettled, createImageTextureUploader, createTextureTransferTracker, type NativeImageResourceOptions, type SettledImageTextureUploader, type SettledTextureTransferTracker } from "@foss-earth/renderer/babylon";
export function borrowedFrames(input: BorrowedFrameClosureOptions, frames: Pick<RenderSchedulerOptions, "requestFrame" | "cancelFrame">) {
  const closure = createBorrowedFrameClosure(input);
  return { schedulerOptions: closure.schedulerOptions(frames), dispose: closure.dispose, whenSettled: closure.whenSettled };
}
export function borrowedResources(input: NativeImageResourceOptions) { return createNativeImageResources(input); }
export function actualDeviceDrain(input: Parameters<typeof whenBorrowedDeviceSettled>[0]): Promise<void> { return whenBorrowedDeviceSettled(input); }
export function richerNativeFactories(uploader: ReturnType<typeof createImageTextureUploader>, tracker: ReturnType<typeof createTextureTransferTracker>) {
  const uploads: SettledImageTextureUploader = uploader, transfers: SettledTextureTransferTracker = tracker;
  return Promise.allSettled([uploads.whenSettled(), transfers.whenSettled()]);
}
export const structuralSignal = (signal: AbortSignal): BorrowedFrameSignal => signal;
export const featureFrames = (input: Parameters<typeof createFeatureFramePreparation>[0]) => createFeatureFramePreparation(input);
export const resourceFrames = (input: Parameters<typeof createResourceFrameWork>[0]) => createResourceFrameWork(input);
