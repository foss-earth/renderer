import type { RendererMode, RendererSelection } from "./rendererTypes.js";
import { RENDERER_FALLBACK_RETRY_MS } from "./rendererPreference.js";

export function getRendererLabel(mode: RendererMode): string {
  if (mode === "webgpu") return "WebGPU";
  if (mode === "webgl2") return "WebGL2";
  return "WebGL";
}

/** A line for the host's log; its tones are a subset of the game log's. */
export interface RendererStartNote {
  text: string;
  tone: "info" | "warning";
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const clause = (text: string | undefined): string => (text ?? "no reason was given").trim().replace(/\.+$/, "");

/**
 * What a host prints in its log when the renderer starts on WebGL, saying why,
 * or null for WebGPU. A warning means WebGPU was wanted and did not start.
 */
export function describeRendererStart(renderer: Pick<RendererSelection, "mode" | "requested" | "fallbackReason" | "diagnostics">): RendererStartNote | null {
  const { mode, requested, fallbackReason, diagnostics } = renderer;
  if (mode === "webgpu") return null;
  const drawing = `The globe draws with ${getRendererLabel(mode)}`;
  if (requested !== "auto" && requested === mode) return { text: `${drawing}, as chosen in Settings → Renderer.`, tone: "info" };
  if (diagnostics?.webGlRequired) return { text: `${drawing}: ${clause(fallbackReason)}.`, tone: "info" };
  if (requested === "webgpu") {
    return { text: `WebGPU was chosen but did not start, so the globe draws with ${getRendererLabel(mode)}: ${clause(fallbackReason)}.`, tone: "warning" };
  }
  const savedAt = diagnostics?.fallbackSavedAt;
  if (savedAt !== undefined) {
    return {
      text: `${drawing}, because WebGPU failed here on ${day(savedAt)}: ${clause(fallbackReason)}. `
        + `WebGPU is tried again from ${day(savedAt + RENDERER_FALLBACK_RETRY_MS)}, or sooner if the browser changes.`,
      tone: "warning",
    };
  }
  if (diagnostics && !diagnostics.isSecureContext) {
    return { text: `${drawing}, because WebGPU needs a secure page (HTTPS or localhost), and this one is not.`, tone: "warning" };
  }
  if (diagnostics && !diagnostics.navigatorGpuPresent) return { text: `${drawing}, because this browser does not offer WebGPU.`, tone: "info" };
  return { text: `${drawing}, because WebGPU did not start: ${clause(fallbackReason)}.`, tone: "warning" };
}
