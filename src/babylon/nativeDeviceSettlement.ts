import type { Scene } from "@babylonjs/core";
import { isBorrowedWebGpuEngine } from "./imageTextureUpload.js";

/** Call after all owner parsers/decode jobs have retired, on the LIVE borrowed
 * device. Covers native commands submitted by Babylon as well as our uploads.
 * A rejected/missing completion observer keeps this pending until observed loss.
 */
export function whenBorrowedDeviceSettled(options: {
  scene: Scene; observeDeviceLoss(listener: () => void): () => void; onError(error: unknown): void;
}): Promise<void> {
  const engine = options.scene.getEngine();
  return new Promise<void>((resolve, reject) => {
    let finished = false, subscribing = true, lossDuringSubscription = false, stop = () => {}, failure: unknown;
    const finish = (): void => {
      if (finished) return; finished = true;
      try { stop(); } catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Device settlement cleanup failed."); }
      if (failure === undefined) resolve(); else reject(failure);
    };
    const unknown = (error: unknown): void => {
      if (finished) return;
      failure = error;
      try { options.onError(error); } catch (reporting) { failure = new AggregateError([error, reporting], "Device completion observation failed."); }
    };
    try {
      stop = options.observeDeviceLoss(() => {
        if (subscribing) lossDuringSubscription = true; else finish();
      });
      subscribing = false;
      if (lossDuringSubscription) { finish(); return; }
      if (isBorrowedWebGpuEngine(engine)) {
        const device = engine._device;
        if (device?.lost) void device.lost.then(finish, unknown);
        try { void device.queue.onSubmittedWorkDone().then(finish, unknown); } catch (error) { unknown(error); }
      } else {
        const gl = (engine as unknown as { _gl?: WebGLRenderingContext })._gl;
        if (!gl || typeof gl.finish !== "function") { unknown(new Error("The borrowed device has no native completion observation.")); return; }
        gl.finish(); finish();
      }
    } catch (error) { unknown(error); }
  });
}
