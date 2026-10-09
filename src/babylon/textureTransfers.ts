import type { Engine, Scene } from "@babylonjs/core";
import type { UploadTicket } from "./imageUploadTypes.js";
import type { TextureTransferAdmission, TextureTransferOutcome, TextureTransferRetirement, TryAdmitTextureTransfer } from "../textureTransferTypes.js";
import { isBorrowedWebGpuEngine } from "./imageTextureUpload.js";

/** Retained structural compatibility for existing immediate callers. */
export interface TextureTransferTracker {
  transfer<T>(bytes: number, label: string, submit: () => T): T;
  track<T>(ticket: UploadTicket, submit: () => T): T;
  pump(): void;
  /** Call only after the host has observed actual device/context loss. */
  deviceLost(): void;
  dispose(): void;
}
export interface CompletionTextureTransferTracker extends TextureTransferTracker {
  readonly tryAdmit: TryAdmitTextureTransfer;
}
/** One supplied broker, backend and host frame, including legacy immediate work. */
export function createTextureTransferTracker(options: {
  scene: Scene;
  admit(bytes: number, label: string): UploadTicket | null;
  requestRender(): void;
}): CompletionTextureTransferTracker {
  const engine = options.scene.getEngine();
  const gpu = isBorrowedWebGpuEngine(engine);
  type Entry = {
    ticket: UploadTicket; releaseInput: (() => void) | null;
    phase: "admitted" | "retaining" | "submitting" | "native" | "retiring" | "retired";
    outcome: TextureTransferOutcome | null;
    resolveOutcome: ((outcome: TextureTransferOutcome) => void) | null;
    resolveRetirement: ((retirement: TextureTransferRetirement) => void) | null;
  };
  type Flight = { sync: WebGLSync; entry: Entry };
  const entries = new Set<Entry>();
  const fences: Flight[] = [];
  let disposed = false;
  let lost = false;
  const errorFrom = (errors: unknown[], message: string): unknown => errors.length === 1 ? errors[0] : new AggregateError(errors, message);
  const settle = (entry: Entry, outcome: TextureTransferOutcome): void => {
    if (entry.outcome) return;
    entry.outcome = outcome; entry.resolveOutcome?.(outcome);
  };
  const retire = (entry: Entry, status: TextureTransferRetirement["status"], errors: unknown[] = []): unknown[] => {
    if (entry.phase === "retired") return errors;
    entry.phase = "retired"; entries.delete(entry);
    // Retire bookkeeping before supplied releases can reenter any lifecycle.
    const releaseInput = entry.releaseInput; entry.releaseInput = null;
    try { releaseInput?.(); } catch (error) { errors.push(error); }
    try { entry.ticket.release(); } catch (error) { errors.push(error); }
    entry.resolveRetirement?.(errors.length ? { status, cleanupError: errorFrom(errors, "Texture transfer retirement cleanup failed.") } : { status });
    return errors;
  };
  const completed = (entry: Entry, errors: unknown[] = []): unknown[] => {
    settle(entry, lost ? { status: "device-lost" } : { status: "uploaded" });
    return retire(entry, lost ? "device-lost" : "completed", errors);
  };
  const fail = (entry: Entry, error: unknown): void => settle(entry, { status: "failed", error });
  const deleteFlight = (flight: Flight): unknown[] => {
    const index = fences.indexOf(flight); if (index >= 0) fences.splice(index, 1);
    if (flight.entry.phase !== "retired") flight.entry.phase = "retiring";
    const errors: unknown[] = [];
    try { (engine as Engine)._gl.deleteSync(flight.sync); } catch (error) { errors.push(error); }
    return completed(flight.entry, errors);
  };
  const releaseFences = (finish: boolean): unknown[] => {
    const errors: unknown[] = [];
    const snapshot = [...fences];
    if (finish && snapshot.length) {
      try { (engine as Engine)._gl.finish(); }
      catch (error) { for (const flight of snapshot) fail(flight.entry, error); return [error]; }
    }
    for (const flight of snapshot) if (fences.includes(flight)) errors.push(...deleteFlight(flight));
    return errors;
  };
  const after = (entry: Entry): unknown[] => {
    if (entry.phase === "retired") return [];
    entry.phase = "native";
    if (lost) { settle(entry, { status: "device-lost" }); return retire(entry, "device-lost"); }
    if (gpu) {
      try {
        const queue = (engine as unknown as { _device: { queue: { onSubmittedWorkDone(): Promise<void> } } })._device.queue;
        // Rejection is a failed observation, not proof of retirement or loss.
        // Both handlers contain release errors through the retirement record.
        void queue.onSubmittedWorkDone().then(
          () => { completed(entry); },
          error => { fail(entry, error); },
        );
      } catch (error) { fail(entry, error); /* Observation failed: retain native work until actual loss. */ }
      return [];
    }
    const gl = (engine as Engine)._gl;
    if ((engine as Engine).webGLVersion < 2 || !gl) return completed(entry);
    if (disposed) {
      try { gl.finish(); } catch (error) { fail(entry, error); return [error]; }
      return completed(entry);
    }
    let sync: WebGLSync | null = null;
    try { sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); } catch { /* Prove completion with finish below. */ }
    if (lost || !entries.has(entry)) {
      const errors: unknown[] = [];
      try { if (sync) gl.deleteSync(sync); } catch (error) { errors.push(error); }
      settle(entry, { status: "device-lost" }); errors.push(...retire(entry, "device-lost")); return errors;
    }
    if (!sync) {
      try { gl.finish(); } catch (error) { fail(entry, error); return [error]; }
      return completed(entry);
    }
    fences.push({ sync, entry });
    if (disposed) return releaseFences(true);
    try { gl.flush(); if (!disposed && !lost) options.requestRender(); }
    catch (error) { fail(entry, error); return [error]; }
    return [];
  };
  const track = <T>(ticket: UploadTicket, submit: () => T): T => {
    if (disposed || lost) { ticket.release(); throw new Error("The texture transfer tracker is unavailable."); }
    const entry: Entry = { ticket, releaseInput: null, phase: "submitting", outcome: null, resolveOutcome: null, resolveRetirement: null };
    entries.add(entry);
    const errors: unknown[] = [];
    let value!: T;
    try { value = submit(); } catch (error) { fail(entry, error); errors.push(error); }
    errors.push(...after(entry));
    if (errors.length) throw errorFrom(errors, "Texture transfer submission failed.");
    return value;
  };
  const cancel = (entry: Entry, reason: unknown): void => {
    fail(entry, reason);
    if (entry.phase === "admitted") retire(entry, "completed");
  };
  const tryAdmit: TryAdmitTextureTransfer = (bytes, label, retainInput) => {
    if (disposed || lost) throw new Error("The texture transfer tracker is unavailable.");
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Texture transfer bytes must be a nonnegative integer.");
    const ticket = options.admit(bytes, label);
    if (!ticket) return null;
    let resolveOutcome!: (outcome: TextureTransferOutcome) => void;
    let resolveRetirement!: (retirement: TextureTransferRetirement) => void;
    const settled = new Promise<TextureTransferOutcome>(resolve => { resolveOutcome = resolve; });
    const retired = new Promise<TextureTransferRetirement>(resolve => { resolveRetirement = resolve; });
    const entry: Entry = { ticket, releaseInput: null, phase: "admitted", outcome: null, resolveOutcome, resolveRetirement };
    // Admission may reenter teardown; never retain/copy after that boundary.
    if (disposed || lost) {
      settle(entry, lost ? { status: "device-lost" } : { status: "failed", error: new Error("The texture transfer tracker was disposed during admission.") });
      retire(entry, lost ? "device-lost" : "completed");
    } else {
      entries.add(entry); entry.phase = "retaining";
      try {
        entry.releaseInput = retainInput();
        if (typeof entry.releaseInput !== "function") throw new Error("Texture transfer input retention must return a release function.");
      } catch (error) { fail(entry, error); }
      entry.phase = "admitted";
      // Retention can reenter teardown; its returned hold is cleaned independently.
      if (lost) { settle(entry, { status: "device-lost" }); retire(entry, "device-lost"); }
      else if (disposed || entry.outcome) {
        fail(entry, new Error("The texture transfer tracker was disposed during input retention.")); retire(entry, "completed");
      }
    }
    const admission: TextureTransferAdmission = {
      settled, retired,
      get active() { return (entry.phase === "admitted" || entry.phase === "submitting" || entry.phase === "native") && !entry.outcome && !disposed && !lost; },
      submit(copy) {
        if (entry.phase !== "admitted" || entry.outcome) return;
        entry.phase = "submitting";
        try { copy(() => entry.phase === "submitting" && !entry.outcome && !disposed && !lost); }
        catch (error) { fail(entry, error); }
        // No native hook is assumed safe after a throwing/partial callback.
        after(entry);
      },
      cancel(reason = new Error("Texture transfer cancelled.")) { cancel(entry, reason); },
    };
    return admission;
  };
  return {
    tryAdmit,
    transfer(bytes, label, submit) {
      if (disposed || lost) throw new Error("The texture transfer tracker is unavailable.");
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Texture transfer bytes must be a nonnegative integer.");
      const ticket = options.admit(bytes, label);
      if (!ticket) throw new Error(`${label}: texture upload capacity is unavailable.`);
      return track(ticket, submit);
    },
    track,
    pump() {
      if (lost || disposed || !fences.length) return;
      const gl = (engine as Engine)._gl;
      const errors: unknown[] = [];
      for (const flight of [...fences]) {
        if (!fences.includes(flight)) continue;
        try {
          const result = gl.clientWaitSync(flight.sync, 0, 0);
          if (lost || !fences.includes(flight)) continue;
          if (result === gl.TIMEOUT_EXPIRED) continue;
          if (result === gl.WAIT_FAILED) gl.finish();
          else if (result !== gl.ALREADY_SIGNALED && result !== gl.CONDITION_SATISFIED) throw new Error("Unknown texture transfer fence result.");
          if (fences.includes(flight)) errors.push(...deleteFlight(flight));
        } catch (error) { fail(flight.entry, error); errors.push(error); }
      }
      if (fences.length && !disposed && !lost) {
        try { options.requestRender(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errorFrom(errors, "Texture transfer pump failed.");
    },
    deviceLost() {
      if (lost) return; lost = true;
      const errors: unknown[] = [];
      errors.push(...releaseFences(false));
      for (const entry of [...entries]) {
        settle(entry, { status: "device-lost" });
        // Active synchronous callbacks may still read their input afterward.
        if (entry.phase !== "submitting" && entry.phase !== "retaining" && entry.phase !== "retiring") errors.push(...retire(entry, "device-lost"));
      }
      if (errors.length) throw errorFrom(errors, "Texture transfer loss cleanup failed.");
    },
    dispose() {
      if (disposed) return; disposed = true;
      for (const entry of [...entries]) if (entry.resolveOutcome) cancel(entry, new Error("The texture transfer tracker was disposed."));
      const errors = releaseFences(!lost);
      if (errors.length) throw errorFrom(errors, "Texture transfer disposal cleanup failed.");
    },
  };
}
