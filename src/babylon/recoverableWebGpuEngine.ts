import { WebGPUEngine } from "@babylonjs/core";
import { WebGPUCacheBindGroups } from "@babylonjs/core/Engines/WebGPU/webgpuCacheBindGroups.js";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree.js";

/**
 * Babylon 8.56.2's WebGPU restoration does not await device initialization and
 * omits the scene geometry rebuild performed by its WebGL Engine. Keep this
 * pinned-version adapter at the device owner: feature resources still retire
 * and reacquire through Babylon's ordinary lost/restored observations.
 */
export class RecoverableWebGpuEngine extends WebGPUEngine {
  onRestoreError?: (error: unknown) => void;
  private restoreRunning = false;
  private restoringDevice: object | null = null;
  private queuedRestore: { device: object; initialize: () => void } | null = null;
  private lossRevision = 0;

  protected override _restoreEngineAfterContextLost(initialize: () => void): void {
    if (this.isDisposed) return;
    const device = this._device;
    // A device has one loss. Repeated notifications must not initialize two
    // replacements concurrently; a replacement that itself fails is queued.
    if (device === this.restoringDevice || device === this.queuedRestore?.device) return;
    this.lossRevision += 1;
    this.queuedRestore = { device, initialize };
    if (this.restoreRunning) return;
    this.restoreRunning = true;
    void this.restoreDevices();
  }

  private async restoreDevices(): Promise<void> {
    try {
      while (this.queuedRestore && !this.isDisposed) {
        const operation = this.queuedRestore;
        this.queuedRestore = null;
        this.restoringDevice = operation.device;
        const revision = this.lossRevision;
        // Preserve Babylon's browser-level deferred restoration, without a
        // second deferred rebuild after initialization has completed.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (this.isDisposed) return;
        const depth = {
          test: this._depthCullingState.depthTest,
          func: this._depthCullingState.depthFunc,
          mask: this._depthCullingState.depthMask,
          stencil: this._stencilState.stencilTest,
        };
        try {
          this._clearEmptyResources();
          // The pipeline helper captures the global tree's root in its
          // constructor. Reset before init creates that helper, so neither
          // it nor later helpers can inherit pipelines from the lost device.
          WebGPUCacheRenderPipelineTree.ResetCache();
          WebGPUCacheBindGroups.ResetCache();
          // Babylon's callback is typed void, but WebGPU supplies an async
          // function that resolves only after all new device helpers exist.
          await operation.initialize();
          if (this.isDisposed) {
            // Initialization may have installed a replacement after dispose
            // destroyed the old device. Retire that unreturned replacement.
            if (this._device !== operation.device) this._device.destroy();
            return;
          }
          this._depthCullingState.depthTest = depth.test;
          this._depthCullingState.depthFunc = depth.func;
          this._depthCullingState.depthMask = depth.mask;
          this._stencilState.stencilTest = depth.stencil;
          if (revision !== this.lossRevision) continue;
          this.resetSceneBindings();
          this._rebuildGraphicsResources();
          if (this.isDisposed) return;
          if (revision !== this.lossRevision) continue;
          this._depthCullingState.depthTest = depth.test;
          this._depthCullingState.depthFunc = depth.func;
          this._depthCullingState.depthMask = depth.mask;
          this._stencilState.stencilTest = depth.stencil;
          // Set this before notifying: a host may dispose the engine or a
          // newly restored device may be lost from a subscriber's callback.
          this._contextWasLost = false;
          this.onContextRestoredObservable.notifyObservers(this);
        } catch (error) {
          if (!this.isDisposed) {
            try {
              if (this.onRestoreError) this.onRestoreError(error);
              else console.error("[renderer] WebGPU device restoration failed.", error);
            } catch (reportError) {
              console.error("[renderer] WebGPU restoration diagnostics failed.", error, reportError);
            }
          }
        }
      }
    } finally {
      this.restoreRunning = false;
      this.restoringDevice = null;
      this.queuedRestore = null;
    }
  }

  /** Babylon's WebGPU-specific restoration cleanup, after awaited init. */
  private resetSceneBindings(): void {
    for (const scene of [...this.scenes, ...this._virtualScenes]) {
      for (const mesh of scene.meshes) {
        for (const subMesh of mesh.subMeshes ?? []) subMesh._drawWrappers = [];
      }
      for (const material of scene.materials) material._materialContext?.reset();
    }
    // These buffers are recreated with their effects, as in Babylon's own
    // WebGPU restore path; rebuilding the retired buffers would retain them.
    this._uniformBuffers = this._uniformBuffers.filter(buffer => !buffer.name.includes("leftOver"));
  }

  protected override _rebuildBuffers(): void {
    for (const scene of [...this.scenes, ...this._virtualScenes]) {
      scene.resetCachedMaterial();
      scene._rebuildGeometries();
    }
    super._rebuildBuffers();
  }
}
