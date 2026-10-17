import { describe, expect, it } from "vitest";
import { describeRendererStart } from "../src/rendererStartNote.js";
import { RENDERER_FALLBACK_RETRY_MS } from "../src/rendererPreference.js";

const secure = { navigatorGpuPresent: true, isSupportedAsyncResult: null, isSecureContext: true };

describe("the renderer's line in the log at startup", () => {
  it("says nothing for WebGPU", () => {
    expect(describeRendererStart({ mode: "webgpu", requested: "auto", diagnostics: secure })).toBeNull();
    expect(describeRendererStart({ mode: "webgpu", requested: "webgpu" })).toBeNull();
  });
  it("notes a chosen WebGL and a headset's WebGL as information", () => {
    expect(describeRendererStart({ mode: "webgl2", requested: "webgl2" })).toEqual({ tone: "info", text: "The globe draws with WebGL2, as chosen in Settings → Renderer." });
    expect(describeRendererStart({ mode: "webgl2", requested: "auto", fallbackReason: "this device can present immersive VR, which needs WebGL",
      diagnostics: { ...secure, webGlRequired: true } })).toEqual({ tone: "info", text: "The globe draws with WebGL2: this device can present immersive VR, which needs WebGL." });
  });
  it("warns when a chosen WebGPU did not start, with the reason", () => {
    expect(describeRendererStart({ mode: "webgl2", requested: "webgpu", fallbackReason: "adapter lost.", diagnostics: secure }))
      .toEqual({ tone: "warning", text: "WebGPU was chosen but did not start, so the globe draws with WebGL2: adapter lost." });
  });
  it("warns about a saved fallback, with when WebGPU is tried again", () => {
    const at = Date.UTC(2026, 9, 12, 8);
    const note = describeRendererStart({ mode: "webgl2", requested: "auto", fallbackReason: "probe failed",
      diagnostics: { ...secure, fromPersistedPreference: true, fallbackSavedAt: at } });
    expect(note?.tone).toBe("warning");
    expect(note?.text).toBe(`The globe draws with WebGL2, because WebGPU failed here on 2026-10-12: probe failed. WebGPU is tried again from ${new Date(at + RENDERER_FALLBACK_RETRY_MS).toISOString().slice(0, 10)}, or sooner if the browser changes.`);
    expect(note?.text).toContain("from 2026-10-15");
  });
  it("names an insecure page, such as a phone on the dev server's address, before anything else", () => {
    expect(describeRendererStart({ mode: "webgl2", requested: "auto", fallbackReason: "WebGPUEngine.IsSupportedAsync returned false",
      diagnostics: { navigatorGpuPresent: false, isSupportedAsyncResult: false, isSecureContext: false } }))
      .toEqual({ tone: "warning", text: "The globe draws with WebGL2, because WebGPU needs a secure page (HTTPS or localhost), and this one is not." });
  });
  it("notes a browser without WebGPU as information, and any other failure as a warning", () => {
    expect(describeRendererStart({ mode: "webgl", requested: "auto", fallbackReason: "x",
      diagnostics: { navigatorGpuPresent: false, isSupportedAsyncResult: false, isSecureContext: true } }))
      .toEqual({ tone: "info", text: "The globe draws with WebGL, because this browser does not offer WebGPU." });
    expect(describeRendererStart({ mode: "webgl2", requested: "auto", fallbackReason: "Requested allocation size is too small.", diagnostics: secure }))
      .toEqual({ tone: "warning", text: "The globe draws with WebGL2, because WebGPU did not start: Requested allocation size is too small." });
  });
});
