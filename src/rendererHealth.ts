import type { AbstractEngine, Scene } from "@babylonjs/core";

export interface RendererHealthSource {
  engine: Partial<Pick<AbstractEngine, "frameId" | "onBeginFrameObservable" | "onEndFrameObservable" | "onContextLostObservable" | "onContextRestoredObservable">>;
  scene?: Partial<Pick<Scene, "onBeforeRenderObservable" | "onAfterRenderObservable">>;
  isRendering?(): boolean;
}

/** Observes CPU frame boundaries and native errors; imports no Babylon runtime and schedules no work. */
export function observeRendererHealth(source: RendererHealthSource, options: {
  now(): number;
  /** Called for the first four distinct errors, for the host's persistent trail. */
  onError?(message: string): void;
}) {
  const attachedAtMs = options.now();
  let disposed = false;
  let phase = "waiting";
  let phaseAtMs = attachedAtMs;
  let begun = 0, sceneBegun = 0, sceneCompleted = 0, ended = 0;
  let lastBeginMs: number | null = null, lastSceneMs: number | null = null, lastEndMs: number | null = null;
  let maxFrameGapMs = 0;
  let lost = false, losses = 0, restorations = 0, errorCount = 0, droppedErrors = 0;
  let trailErrors = 0;
  let device: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null = null;
  const errors: Array<{ name: string; message: string; shortened: boolean; count: number; firstMs: number; lastMs: number; engineFrame: number | null; phase: string }> = [];
  const stops: Array<() => void> = [];
  const setPhase = (next: string) => { phase = next; phaseAtMs = options.now(); };
  const onError: EventListener = event => {
    if (disposed) return;
    const error = (event as Event & { error?: { message?: string; constructor?: { name?: string } } }).error;
    const raw = error?.message ?? String(error);
    const name = error?.constructor?.name ?? "GPUError";
    const message = raw.slice(0, 32_768);
    const now = options.now();
    errorCount++;
    const seen = errors.find(entry => entry.name === name && entry.message === message);
    if (seen) { seen.count++; seen.lastMs = now; return; }
    // Retain the first cause and the latest distinct errors within 262,144 characters.
    if (errors.length === 8) { errors.splice(1, 1); droppedErrors++; }
    errors.push({ name, message, shortened: raw.length > message.length, count: 1, firstMs: now, lastMs: now,
      engineFrame: source.engine.frameId ?? null, phase });
    try { if (trailErrors++ < 4) options.onError?.(`${name} at engine frame ${source.engine.frameId ?? "unknown"}: ${message}`); }
    catch { /* Diagnostics must never interrupt native error dispatch. */ }
  };
  const detachDevice = () => { device?.removeEventListener("uncapturederror", onError); device = null; };
  const bindDevice = () => {
    detachDevice();
    // Babylon 8.56.2 exposes the shared device through this pinned-version port.
    const engine = source.engine as typeof source.engine & { device?: typeof device; _device?: typeof device };
    device = engine.device ?? engine._device ?? null;
    device?.addEventListener("uncapturederror", onError);
  };
  const begin = source.engine.onBeginFrameObservable?.add(() => {
    if (disposed) return;
    const now = options.now();
    if (lastBeginMs !== null) maxFrameGapMs = Math.max(maxFrameGapMs, now - lastBeginMs);
    lastBeginMs = now; begun++; setPhase("preparing");
  });
  stops.push(() => { if (begin) source.engine.onBeginFrameObservable?.remove(begin); });
  const before = source.scene?.onBeforeRenderObservable?.add(() => { if (!disposed) { sceneBegun++; setPhase("scene"); } });
  stops.push(() => { if (before) source.scene?.onBeforeRenderObservable?.remove(before); });
  const after = source.scene?.onAfterRenderObservable?.add(() => { if (!disposed) { sceneCompleted++; lastSceneMs = options.now(); setPhase("awaiting submission"); } });
  stops.push(() => { if (after) source.scene?.onAfterRenderObservable?.remove(after); });
  const end = source.engine.onEndFrameObservable?.add(() => { if (!disposed) { ended++; lastEndMs = options.now(); setPhase("frame ended"); } });
  stops.push(() => { if (end) source.engine.onEndFrameObservable?.remove(end); });
  const loss = source.engine.onContextLostObservable?.add(() => { if (!disposed) { losses++; lost = true; setPhase("device lost"); detachDevice(); } });
  stops.push(() => { if (loss) source.engine.onContextLostObservable?.remove(loss); });
  const restore = source.engine.onContextRestoredObservable?.add(() => { if (!disposed) { restorations++; lost = false; setPhase("restored"); bindDevice(); } });
  stops.push(() => { if (restore) source.engine.onContextRestoredObservable?.remove(restore); });
  bindDevice();
  return {
    snapshot() {
      const now = options.now();
      const age = (at: number | null) => at === null ? null : Math.max(0, now - at);
      return { version: 1, capturedAtMs: now, attachedAtMs, phase, phaseAgeMs: age(phaseAtMs),
        schedulerActive: source.isRendering?.() ?? null, engineFrame: source.engine.frameId ?? null,
        frames: { begun, sceneBegun, sceneCompleted, ended, lastBeginAgeMs: age(lastBeginMs), lastSceneAgeMs: age(lastSceneMs), lastEndAgeMs: age(lastEndMs), maxFrameGapMs },
        gpu: { listening: device !== null, lost, losses, restorations, errorCount, droppedErrors, errors: errors.map(error => ({ ...error })) },
        limitation: "CPU frame completion does not prove that the GPU presented the picture. No GPU fences or readbacks are added." };
    },
    dispose() { if (disposed) return; disposed = true; detachDevice(); for (const stop of stops) stop(); },
  };
}
