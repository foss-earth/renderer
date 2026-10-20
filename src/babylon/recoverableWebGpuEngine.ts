import { WebGPUEngine } from "@babylonjs/core";
import type { IColor4Like } from "@babylonjs/core/Maths/math.like.js";
import type { OcclusionQuery } from "@babylonjs/core/Engines/AbstractEngine/abstractEngine.query.js";
import { WebGPUCacheBindGroups } from "@babylonjs/core/Engines/WebGPU/webgpuCacheBindGroups.js";
import { WebGPUCacheRenderPipelineTree } from "@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipelineTree.js";
// DynamicTexture brings the WebGL engine's dynamic texture methods but not the WebGPU engine's, which
// only Babylon's index imports, and a build of only the Babylon modules used (babylonBarrels) leaves it out.
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture.js";

/** A clear of the canvas's depth or stencil that no draw has needed yet. */
interface HeldClear {
  depth: boolean;
  stencil: boolean;
  stencilValue: number;
}

/** Babylon's comparisons: ALWAYS is also what a depth function left unset means. */
const LEQUAL = 515, GEQUAL = 518, ALWAYS = 519;

/**
 * Babylon 8.56.2's WebGPU restoration does not await device initialization and
 * omits the scene geometry rebuild performed by its WebGL Engine. Keep this
 * pinned-version adapter at the device owner: feature resources still retire
 * and reacquire through Babylon's ordinary lost/restored observations.
 */
export class RecoverableWebGpuEngine extends WebGPUEngine {
  onRestoreError?: (error: unknown) => void;
  /**
   * Whether a clear of only the canvas's depth or stencil, as Babylon makes
   * before each rendering group after the first, waits for the first draw
   * that reads or writes them. WebGPU clears by starting a render pass, and a
   * tiled GPU, as phones have, writes the whole frame out at the end of each
   * pass and reads it back at the start of the next. A group that ignores
   * depth, as a 360 image does, or draws over everything, as a marker does,
   * then draws in the pass already open, and the frame looks the same. Off
   * clears as Babylon does, to compare against.
   */
  deferDepthClears = true;
  private heldClear: HeldClear | null = null;
  private restoreRunning = false;
  private restoringDevice: object | null = null;
  private queuedRestore: { device: object; initialize: () => void } | null = null;
  private lossRevision = 0;

  override clear(color: IColor4Like | null, backBuffer: boolean, depth: boolean, stencil = false, stencilClearValue = 0): void {
    if (this._currentRenderTarget) {
      super.clear(color, backBuffer, depth, stencil, stencilClearValue);
      return;
    }
    const scissored = this.scissorActive();
    if (this.deferDepthClears && this._currentRenderPass && !scissored && !(backBuffer && color) && !this.snapshotRendering) {
      // What Babylon's clear changes for the draws after it, without its new pass.
      if (color && color.a === undefined) color.a = 1;
      if (stencil) this._clearStencilValue = stencilClearValue;
      if (this.useReverseDepthBuffer) this.setDepthFunctionToGreaterOrEqual();
      const held = this.heldClear;
      if (depth || stencil) {
        this.heldClear = { depth: depth || !!held?.depth, stencil: stencil || !!held?.stencil, stencilValue: stencil ? stencilClearValue : held?.stencilValue ?? 0 };
      }
      return;
    }
    const held = this.heldClear;
    if (held && !scissored) {
      // This clear starts a pass, which makes the held clear too.
      this.heldClear = null;
      const stencilValue = this._clearStencilValue;
      super.clear(color, backBuffer, depth || held.depth, stencil || held.stencil, stencil ? stencilClearValue : held.stencilValue);
      if (!stencil) this._clearStencilValue = stencilValue;
      return;
    }
    this.releaseClear();
    super.clear(color, backBuffer, depth, stencil, stencilClearValue);
  }

  override drawElementsType(fillMode: number, indexStart: number, indexCount: number, instancesCount?: number): void {
    if (this.heldClear) this.drawHeld(this.heldClear, () => super.drawElementsType(fillMode, indexStart, indexCount, instancesCount));
    else super.drawElementsType(fillMode, indexStart, indexCount, instancesCount);
  }

  override drawArraysType(fillMode: number, verticesStart: number, verticesCount: number, instancesCount?: number): void {
    if (this.heldClear) this.drawHeld(this.heldClear, () => super.drawArraysType(fillMode, verticesStart, verticesCount, instancesCount));
    else super.drawArraysType(fillMode, verticesStart, verticesCount, instancesCount);
  }

  override beginOcclusionQuery(algorithmType: number, query: OcclusionQuery): boolean {
    // A query ends in the pass it begins in, so the held clear's pass comes
    // first. Without a pass open, the query waits for the next draw's pass.
    if (this._currentRenderPass) this.releaseClear();
    return super.beginOcclusionQuery(algorithmType, query);
  }

  override setSize(width: number, height: number, forceSetSize?: boolean): boolean {
    if (!super.setSize(width, height, forceSetSize)) return false;
    // The canvas's new depth is cleared and its stencil zero, as without the held clear.
    this.heldClear = null;
    return true;
  }

  /**
   * Draws into the canvas with `held` not yet made. It is made first for a
   * draw that starts the canvas's pass, which makes it without a pass of its
   * own, and for one that uses what it clears: stencil, or depth the draw
   * writes or tests. A test that every fragment passes on the cleared depth,
   * as a marker drawn over everything has, is the same as no test, so that
   * draw goes without one. Babylon's compatibility mode, its default, looks a
   * draw's pipeline up each time; otherwise a draw's first is kept.
   */
  private drawHeld(held: HeldClear, draw: () => void): void {
    if (this._currentRenderTarget) return draw();
    if (!this._currentRenderPass) {
      this.releaseClear();
      return draw();
    }
    // The draw settles its stencil state this way first.
    this._stencilStateComposer.apply();
    const state = this._depthCullingState, func = state.depthFunc ?? ALWAYS, tests = state.depthTest && func !== ALWAYS;
    // The canvas clears depth to 0 with a reverse depth buffer and to 1 without.
    const untested = tests && this.compatibilityMode && func === (this.useReverseDepthBuffer ? GEQUAL : LEQUAL);
    if ((held.stencil && this._stencilStateComposer.enabled) || (held.depth && (state.depthMask || (tests && !untested)))) {
      this.releaseClear();
      return draw();
    }
    if (!held.depth || !tests) return draw();
    state.depthFunc = ALWAYS;
    try { draw(); } finally { state.depthFunc = func; }
  }

  /**
   * Makes the held clear as Babylon would have: a new pass of the whole
   * canvas, scissor or not. A pass already open ends here, where Babylon
   * would not start one, so the state the next draw was set up with is kept.
   * Without a pass open, this is the pass Babylon would start for that draw,
   * resetting its depth function as Babylon does.
   */
  private releaseClear(): void {
    const held = this.heldClear;
    if (!held || this._currentRenderTarget) return;
    this.heldClear = null;
    const restart = !!this._currentRenderPass, scissor = this._scissorCached, { x, y, z, w } = scissor;
    const depthFunc = this._depthCullingState.depthFunc, stencilValue = this._clearStencilValue;
    scissor.x = scissor.y = scissor.z = scissor.w = 0;
    super.clear(null, false, held.depth, held.stencil, held.stencilValue);
    scissor.x = x; scissor.y = y; scissor.z = z; scissor.w = w;
    if (restart) this._depthCullingState.depthFunc = depthFunc;
    this._clearStencilValue = stencilValue;
  }

  private scissorActive(): boolean {
    const scissor = this._scissorCached;
    return scissor.x !== 0 || scissor.y !== 0 || scissor.z !== 0 || scissor.w !== 0;
  }

  protected override _restoreEngineAfterContextLost(initialize: () => void): void {
    // The restored device's canvas starts cleared, as without the held clear.
    this.heldClear = null;
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
