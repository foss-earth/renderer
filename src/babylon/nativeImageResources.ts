/** Generic native portion of App/nativeResources; atlas policy remains Engine-owned. */
import { attemptNativeCleanup } from "../borrowedFrameClosure.js";
import { createResourceFrameWork } from "../featureFramePreparation.js";
import { createImageTextureUploader } from "./imageTextureUpload.js";
import { createTextureDevicePorts, type RawTextureBatchDevicePorts } from "./textureDevice.js";
import { createImageRegionDevicePorts, type ImageRegionDevicePorts } from "./imageRegionDevice.js";
import { createCanvasTextureDevicePorts } from "./canvasTextureDevice.js";
import { createTextureTransferTracker } from "./textureTransfers.js";
import type { ImageTextureUploaderOptions, SettledImageTextureUploader, UploadTicket } from "./imageUploadTypes.js";

/** Structural borrowed Images authority: no broker/cache is created or disposed. */
export interface NativeImageResourceBroker {
  pools: {
    reserve(pool: "uploadOutstanding", bytes: number, label: string): { ok: true; reservation: UploadTicket } | { ok: false };
  };
  invalidate(): void;
}
export interface NativeImageResourceOptions {
  broker: NativeImageResourceBroker;
  scene: ImageTextureUploaderOptions["scene"];
  limits(): ImageTextureUploaderOptions["limits"];
  wakeWork(): void;
  createCanvas: ImageTextureUploaderOptions["createStagingCanvas"];
  invalidatePublishedSource: ImageTextureUploaderOptions["invalidatePublishedSource"];
  after(callback: () => void, delayMs: number): () => void;
  observeDeviceLoss(listener: () => void): () => void;
  onRetirementError(error: unknown): void;
  /** Optional native device boundary, chiefly CPU fixtures; must report real settlement. */
  createUploader?(options: ImageTextureUploaderOptions): SettledImageTextureUploader;
  /** Abort starts retirement before Campus awaits host.whenSettled/disposes its device. */
  signal?: AbortSignal;
}

export function createNativeImageResources(options: NativeImageResourceOptions) {
  const { broker, scene } = options;
  let stopped = false, restorationNeeded = false;
  let stopRetirement: (() => void) | undefined, stopLoss: (() => void) | undefined;
  let retirement: Promise<void> | undefined;
  const errors: unknown[] = [];
  const replacedDrains = new Set<Promise<void>>();
  const releaseCallbacks = new Map<() => void, Promise<void>>();
  const report = (error: unknown): void => {
    try { options.onRetirementError(error); } catch (reporting) { errors.push(reporting); }
  };
  const requireDevice = (): void => {
    if (stopped || restorationNeeded) throw new Error("The borrowed native resource device is unavailable.");
  };
  const makeTracker = () => createTextureTransferTracker({ scene,
    admit(bytes, label) { const grant = broker.pools.reserve("uploadOutstanding", bytes, label); return grant.ok ? grant.reservation : null; },
    requestRender: options.wakeWork,
  });
  let tracker = makeTracker();
  const makeDevice = (current = tracker) => createTextureDevicePorts({ scene,
    transfer: (bytes, label, submit) => current.transfer(bytes, label, submit),
    tryAdmit: (bytes, label, retain) => current.tryAdmit(bytes, label, retain),
  });
  let nativeDevice: RawTextureBatchDevicePorts;
  let canvasDevice: ReturnType<typeof createCanvasTextureDevicePorts>;
  const makeRegionDevice = (current = tracker) => createImageRegionDevicePorts({ scene, track: (ticket, submit) => current.track(ticket, submit) });
  let nativeRegionDevice: ImageRegionDevicePorts;
  const makeUploader = () => (options.createUploader ?? createImageTextureUploader)({ scene, limits: options.limits(), requestRender: options.wakeWork,
    createStagingCanvas: options.createCanvas, invalidatePublishedSource: options.invalidatePublishedSource });
  let nativeUploader: SettledImageTextureUploader;
  const rememberDrain = (drain: Promise<void>): void => {
    replacedDrains.add(drain);
    void drain.then(() => replacedDrains.delete(drain), error => { replacedDrains.delete(drain); errors.push(error); report(error); });
  };
  const drainAdapters = async (): Promise<void> => {
    const results = await Promise.allSettled([tracker.whenSettled(), nativeUploader.whenSettled()]);
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    while (replacedDrains.size) await Promise.allSettled([...replacedDrains]);
  };
  try {
    nativeDevice = makeDevice();
    canvasDevice = createCanvasTextureDevicePorts({ scene, createCanvas: options.createCanvas,
      transfer: (bytes, label, submit) => { requireDevice(); return tracker.transfer(bytes, label, submit); },
    });
    nativeRegionDevice = makeRegionDevice();
    nativeUploader = makeUploader();
  }
  catch (error) {
    try { tracker.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Native resource setup and cleanup failed."); }
    throw error;
  }
  const device: RawTextureBatchDevicePorts = {
    createRawTexture: request => { requireDevice(); return nativeDevice.createRawTexture(request); },
    updateTextureData: (...args) => { requireDevice(); return nativeDevice.updateTextureData(...args); },
    prepareRawTextureBatch: request => { requireDevice(); return nativeDevice.prepareRawTextureBatch(request); },
  };
  const regionDevice: ImageRegionDevicePorts = {
    createTexture: request => { requireDevice(); return nativeRegionDevice.createTexture(request); },
    copyImage: (...args) => {
      try { requireDevice(); } catch (error) { args[4].release(); throw error; }
      return nativeRegionDevice.copyImage(...args);
    },
    copyBytes: (...args) => {
      try { requireDevice(); } catch (error) { args[2].release(); throw error; }
      return nativeRegionDevice.copyBytes(...args);
    },
  };
  const uploader: SettledImageTextureUploader = {
    upload: request => { requireDevice(); return nativeUploader.upload(request); },
    pump: () => !stopped && !restorationNeeded ? nativeUploader.pump() : 0,
    busy: () => nativeUploader.busy(), setLimits: limits => nativeUploader.setLimits(limits), stats: () => nativeUploader.stats(),
    cancelAll: (reason, flags) => nativeUploader.cancelAll(reason, flags), whenSettled: async () => {
      await drainAdapters();
      if (errors.length) throw new AggregateError(errors, "Native image work failed.");
    },
  };
  const observedDeviceLoss = (): void => {
    if (restorationNeeded) return;
    restorationNeeded = true;
    try {
      attemptNativeCleanup([
        () => tracker.deviceLost(), () => nativeUploader.cancelAll("Observed device loss", { deviceLost: true }),
        () => broker.invalidate(),
      ], "Native device-loss cleanup failed.");
    } catch (error) { errors.push(error); throw error; }
    finally {
      // Restoring an adapter cannot erase an old asynchronous invalidation.
      // Actual loss retires native inputs; host cleanup may still be pending.
      rememberDrain(tracker.whenSettled()); rememberDrain(nativeUploader.whenSettled());
    }
  };
  const restoreDevice = (): RawTextureBatchDevicePorts => {
    if (stopped) throw new Error("The native resource binding has retired.");
    if (restorationNeeded) {
      const nextTracker = makeTracker();
      try {
        const nextDevice = makeDevice(nextTracker), nextRegion = makeRegionDevice(nextTracker), nextUploader = makeUploader();
        tracker = nextTracker; nativeDevice = nextDevice; nativeRegionDevice = nextRegion; nativeUploader = nextUploader;
        restorationNeeded = false;
      } catch (error) {
        try { nextTracker.dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Native restoration and cleanup failed."); }
        throw error;
      }
    }
    return device;
  };
  const retire = (): void => {
    if (stopped) return;
    stopped = true;
    options.signal?.removeEventListener("abort", abort);
    // Cancel queued work, then retire submitted tracker inputs on the live device.
    for (const action of [() => nativeUploader.cancelAll("Native host retired"), () => tracker.dispose()]) {
      try { action(); } catch (error) { errors.push(error); }
    }
    let settled = false;
    retirement = (async () => {
      await drainAdapters();
      settled = true;
      for (const action of [() => stopRetirement?.(), () => stopLoss?.()]) { try { action(); } catch (error) { errors.push(error); } }
      stopRetirement = undefined; stopLoss = undefined;
      if (errors.length) throw new AggregateError(errors, "Native image retirement failed.");
    })();
    void retirement.catch(report);
    const schedule = (): void => {
      if (settled || stopRetirement) return;
      stopRetirement = options.after(() => {
        stopRetirement = undefined;
        if (settled) return;
        try { nativeUploader.pump(); schedule(); }
        catch (error) { errors.push(error); report(error); /* Keep holds until an actual loss; do not spin. */ }
      }, 16);
    };
    try {
      stopLoss = options.observeDeviceLoss(() => {
        try { observedDeviceLoss(); } catch (error) { errors.push(error); report(error); }
      });
      schedule();
    } catch (error) { errors.push(error); report(error); }
  };
  const abort = (): void => { retire(); };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) retire();
  return {
    device, canvasDevice, regionDevice, uploader, restoreDevice, observedDeviceLoss,
    resourceWork: createResourceFrameWork({ uploader: { pump: () => nativeUploader.pump() },
      transfers: { pump: () => tracker.pump() }, isCurrent: () => !stopped && !restorationNeeded }),
    retire,
    /** Compatible terminal entry; callback is invoked after actual drains, never as proof. */
    dispose(released?: () => void) {
      retire();
      if (released && !releaseCallbacks.has(released)) {
        const release = () => { try { released(); } catch (error) { errors.push(error); report(error); } };
        releaseCallbacks.set(released, retirement!.then(release, release));
      }
    },
    async whenSettled(): Promise<void> {
      // Also preserve errors from compatible final release callbacks.
      await Promise.allSettled([retirement ?? drainAdapters()]);
      await Promise.allSettled([...releaseCallbacks.values()]);
      if (errors.length) throw new AggregateError(errors, "Native image retirement failed.");
    },
    get retiring() { return stopped; },
  };
}
