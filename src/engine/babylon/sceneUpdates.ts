import type { AbstractMesh, Camera, Light, Observable, Scene } from "@babylonjs/core";

/**
 * Knowing when a render-on-demand scene has to be drawn again, so no caller
 * has to remember to ask and no frame is drawn that shows nothing new.
 *
 * The globe draws a frame only when one is asked for (renderScheduler.ts), so
 * two kinds of change would otherwise go unseen until something else, such as
 * a camera move, asked:
 *
 * - **What is in the scene.** A mesh or a light that enters or leaves it
 *   changes the picture, and asks for one frame - but only if the picture
 *   changes. A mesh added that the last frame already drew (added while that
 *   frame was being prepared), or that cannot be seen because it is disabled or
 *   invisible, asks for nothing; whoever shows it later asks then. A mesh taken
 *   away asks only if the last frame drew it, and not while a frame is being
 *   prepared, since that frame will leave it out. Babylon reports additions a
 *   millisecond after they happen and removals as they happen, so all of them
 *   are judged together once the task that reported them is over: a model that
 *   is added and parented under a hidden node in the same task asks for
 *   nothing.
 * - **What a frame could not draw yet.** Babylon skips a mesh whose material is
 *   still compiling or whose textures are still loading, and draws it on a
 *   later frame. On demand there is no later frame unless one is asked for,
 *   which is why a model that had just loaded could stay invisible until the
 *   camera moved. Whenever the scheduler goes idle, the meshes the last frame
 *   meant to draw are checked, and any that were not ready are waited on - by
 *   checking them, never by drawing - and one frame is asked for when all of
 *   them are.
 *
 * The cheapest way to show new content is to have it ready before it is
 * shown: `whenMeshesReady` waits for meshes kept hidden in the scene, so
 * revealing them takes one frame and never a frame that skips them.
 */

/** The first wait between two readiness checks: a shader that is ready is drawn within a frame of it. */
const READY_CHECK_FIRST_MS = 16;
/** The longest wait between two checks, for what is slow or never gets ready, such as a texture that failed. */
const READY_CHECK_LONGEST_MS = 250;
/** How much longer each check that finds nothing newly ready waits; one that does goes back to the first wait. */
const READY_CHECK_GROWTH = 1.5;

export interface ReadinessTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: ReadinessTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Checks `pending` until it reports nothing left, then calls `settled` once.
 * The checks start a frame apart and grow apart while nothing changes, so
 * something that never gets ready costs a check a quarter of a second rather
 * than one a frame. Returns a cancel function.
 */
function checkUntilSettled(
  pendingNow: number,
  pending: () => number,
  settled: () => void,
  timers: ReadinessTimers,
): () => void {
  let handle: unknown = null;
  let delay = READY_CHECK_FIRST_MS;
  let last = pendingNow;
  const check = (): void => {
    handle = null;
    const now = pending();
    if (now === 0) {
      settled();
      return;
    }
    delay = now < last ? READY_CHECK_FIRST_MS : Math.min(READY_CHECK_LONGEST_MS, delay * READY_CHECK_GROWTH);
    last = now;
    handle = timers.setTimeout(check, delay);
  };
  handle = timers.setTimeout(check, delay);
  return () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
}

/** A material that failed to compile, with every fallback tried, will never draw. */
function failedToCompile(mesh: AbstractMesh): boolean {
  for (const subMesh of mesh.subMeshes ?? []) {
    const effect = subMesh.effect;
    if (effect && effect.getCompilationError() && effect.allFallbacksProcessed()) return true;
  }
  return false;
}

/** Nothing more to wait for: it can be drawn, it is gone, or it never will be. */
function settledForReveal(mesh: AbstractMesh): boolean {
  return mesh.isDisposed() || mesh.isReady(true) || failedToCompile(mesh);
}

/** As settledForReveal, and also when it is no longer shown, so it no longer needs a frame. */
function settledForFrame(mesh: AbstractMesh): boolean {
  return mesh.isDisposed() || !mesh.isEnabled() || !mesh.isVisible || mesh.isReady(true) || failedToCompile(mesh);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The wait was cancelled.", "AbortError");
}

export interface WhenMeshesReadyOptions {
  signal?: AbortSignal;
  timers?: ReadinessTimers;
}

/**
 * Resolves once every mesh can be drawn: its materials compiled and its
 * textures loaded, for this scene's lights and settings. Keep the meshes in
 * the scene but hidden - under a disabled node - while waiting, so they compile
 * for the lights that will shine on them, then show them: the frame that
 * shows them draws all of them, and no frame is drawn while they get ready.
 *
 * A mesh that is disposed, or whose material failed to compile, is not waited
 * on; Babylon reports the compile error itself. Rejects when `signal` aborts.
 */
export function whenMeshesReady(
  meshes: readonly AbstractMesh[],
  options: WhenMeshesReadyOptions = {},
): Promise<void> {
  const { signal } = options;
  const timers = options.timers ?? defaultTimers;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    // The first check is also what starts the compiles of hidden meshes,
    // which no frame touches.
    let waiting = meshes.filter(mesh => !settledForReveal(mesh));
    if (waiting.length === 0) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      cancel();
      reject(abortError(signal!));
    };
    const cancel = checkUntilSettled(waiting.length, () => {
      waiting = waiting.filter(mesh => !settledForReveal(mesh));
      return waiting.length;
    }, () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, timers);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SceneUpdatesOptions {
  scene: Scene;
  requestRender(): void;
  /** True from the start of a frame's tick until its render: what changes then, that frame draws. */
  isPreparingFrame(): boolean;
  timers?: ReadinessTimers;
}

export interface SceneUpdates {
  /**
   * The scheduler went idle after a frame. If that frame skipped meshes that
   * were not ready to draw, ask for one more frame when they are.
   */
  settle(): void;
  /** A frame is coming anyway: stop waiting, and judge again after it. */
  cancelSettle(): void;
  dispose(): void;
}

/** Shown, and has something to draw. */
function shown(mesh: AbstractMesh): boolean {
  return !mesh.isDisposed() && mesh.isEnabled() && mesh.isVisible && mesh.getTotalVertices() > 0;
}

/**
 * Asks for frames when meshes and lights enter or leave `scene`, and after a
 * frame that could not draw everything it meant to. See the top of this file.
 */
export function createSceneUpdates(options: SceneUpdatesOptions): SceneUpdates {
  const { scene, requestRender, isPreparingFrame } = options;
  const timers = options.timers ?? defaultTimers;
  let disposed = false;

  let added: AbstractMesh[] = [];
  let removed: AbstractMesh[] = [];
  let judgeQueued = false;
  /** Whether the picture changed: judged once per task, against one copy of the last frame's meshes. */
  const judge = (): void => {
    judgeQueued = false;
    const newMeshes = added;
    const goneMeshes = removed;
    added = [];
    removed = [];
    if (disposed) return;
    let lastFrame: Set<AbstractMesh> | null = null;
    const drewLastFrame = (mesh: AbstractMesh): boolean => {
      if (!lastFrame) {
        const active = scene.getActiveMeshes();
        lastFrame = new Set(active.data.slice(0, active.length));
      }
      return lastFrame.has(mesh);
    };
    if (goneMeshes.some(drewLastFrame) || newMeshes.some(mesh => shown(mesh) && !drewLastFrame(mesh))) requestRender();
  };
  const queueJudge = (): void => {
    if (judgeQueued) return;
    judgeQueued = true;
    queueMicrotask(judge);
  };
  const onMeshAdded = (mesh: AbstractMesh): void => {
    added.push(mesh);
    queueJudge();
  };
  // Babylon takes a mesh out of the scene part way through disposing it, and
  // reports it at once: whether a frame is being prepared is known now.
  const onMeshRemoved = (mesh: AbstractMesh): void => {
    if (isPreparingFrame()) return;
    removed.push(mesh);
    queueJudge();
  };
  const onLightChanged = (light: Light): void => {
    if (isPreparingFrame()) return;
    if (light.isEnabled()) requestRender();
  };
  const unsubscribe: Array<() => void> = [];
  const watch = <T>(observable: Observable<T>, callback: (value: T) => void): void => {
    const observer = observable.add(callback);
    unsubscribe.push(() => observable.remove(observer));
  };
  watch(scene.onNewMeshAddedObservable, onMeshAdded);
  watch(scene.onMeshRemovedObservable, onMeshRemoved);
  watch(scene.onNewLightAddedObservable, onLightChanged);
  watch(scene.onLightRemovedObservable, onLightChanged);

  let cancelWait: (() => void) | null = null;
  const cancelSettle = (): void => {
    cancelWait?.();
    cancelWait = null;
  };

  return {
    settle(): void {
      cancelSettle();
      if (disposed) return;
      // The meshes the last frame meant to draw. Ready ones answer from the
      // frame's own cache, so this costs little even with many tiles.
      const active = scene.getActiveMeshes();
      let waiting: AbstractMesh[] = [];
      for (let i = 0; i < active.length; i += 1) {
        const mesh = active.data[i];
        if (!settledForFrame(mesh)) waiting.push(mesh);
      }
      const camera: Camera | null = scene.activeCamera ?? null;
      // Its post-processes.
      let cameraWaiting = camera !== null && !camera.isReady(true);
      if (waiting.length === 0 && !cameraWaiting) return;
      cancelWait = checkUntilSettled(waiting.length + (cameraWaiting ? 1 : 0), () => {
        waiting = waiting.filter(mesh => !settledForFrame(mesh));
        cameraWaiting = cameraWaiting && scene.activeCamera === camera && !camera!.isReady(true);
        return waiting.length + (cameraWaiting ? 1 : 0);
      }, () => {
        cancelWait = null;
        if (!disposed) requestRender();
      }, timers);
    },
    cancelSettle,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelSettle();
      added = [];
      removed = [];
      for (const stop of unsubscribe) stop();
    },
  };
}
