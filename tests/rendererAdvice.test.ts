import { describe, expect, it } from "vitest";
import {
  adviseRenderer, dismissAdvice, identifyBrowser, readDismissedAdvice, RENDERER_ADVICE_DISMISSED_STORAGE_KEY, WEBGPU_ON_A_PHONE_DOCS,
  type RendererFacts,
} from "../src/rendererAdvice.js";
import { RENDERER_FALLBACK_RETRY_MS } from "../src/rendererPreference.js";

const UA = {
  chromeAndroid: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
  edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
  safariIos18: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  safariMac26: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  firefoxWindows128: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0",
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
};

const secure = { navigatorGpuPresent: true, isSupportedAsyncResult: true, isSecureContext: true };
const facts = (renderer: RendererFacts["renderer"], userAgent: string, more: Partial<RendererFacts> = {}): RendererFacts =>
  ({ renderer, browser: identifyBrowser(userAgent), hostname: "umn-vr.github.io", ...more });
const ids = (input: RendererFacts): string[] => adviseRenderer(input).map(advice => advice.id);

describe("the renderer's advice", () => {
  it("gives none for WebGPU, a chosen WebGL or a headset", () => {
    expect(adviseRenderer(facts({ mode: "webgpu", requested: "auto", diagnostics: secure }, UA.chromeMac))).toEqual([]);
    expect(adviseRenderer(facts({ mode: "webgl2", requested: "webgl2", diagnostics: { ...secure, isSecureContext: false } }, UA.chromeAndroid))).toEqual([]);
    expect(adviseRenderer(facts({ mode: "webgl2", requested: "auto", fallbackReason: "this device can present immersive VR, which needs WebGL",
      diagnostics: { ...secure, webGlRequired: true } }, UA.chromeAndroid))).toEqual([]);
  });

  it("sends a phone on the dev server's address to the guide, and another insecure page to its HTTPS address", () => {
    const insecure = { mode: "webgl2" as const, requested: "auto" as const, diagnostics: { navigatorGpuPresent: false, isSupportedAsyncResult: false, isSecureContext: false } };
    const [phone] = adviseRenderer(facts(insecure, UA.chromeAndroid, { hostname: "192.168.0.103" }));
    expect(phone).toMatchObject({ id: "insecure-origin", tone: "warning", docs: WEBGPU_ON_A_PHONE_DOCS });
    expect(phone?.text).toBe("The globe draws with WebGL2 because WebGPU needs a secure page (HTTPS or localhost), and this one is not.");
    const [site] = adviseRenderer(facts(insecure, UA.safariMac26, { hostname: "example.org" }));
    expect(site).toMatchObject({ id: "insecure-origin", fix: ["Open this page's https:// address instead (https://example.org)."] });
    expect(site?.docs).toBeUndefined();
    // Firefox has no WebGPU on Linux even over HTTPS, so HTTPS would not help.
    expect(ids(facts(insecure, UA.firefoxLinux, { hostname: "192.168.0.103" }))).toEqual([]);
  });

  it("says when a saved fallback lets WebGPU try again, and how to try now", () => {
    const at = Date.UTC(2026, 9, 12, 8);
    const [advice] = adviseRenderer(facts({ mode: "webgl2", requested: "auto", fallbackReason: "probe failed",
      diagnostics: { ...secure, isSupportedAsyncResult: null, fromPersistedPreference: true, fallbackSavedAt: at } }, UA.chromeMac));
    expect(advice).toMatchObject({ id: "stale-preference", tone: "warning", text: "The globe draws with WebGL2 because WebGPU failed here on 2026-10-12." });
    expect(advice?.fix[0]).toBe(`WebGPU is tried again from ${new Date(at + RENDERER_FALLBACK_RETRY_MS).toISOString().slice(0, 10)}, or sooner if the browser changes.`);
    expect(advice?.fix[1]).toBe("To try it now: Settings → Renderer → WebGPU.");
  });

  it("points a GPU the browser leaves out to its status page, without flags", () => {
    const [advice] = adviseRenderer(facts({ mode: "webgl2", requested: "auto", fallbackReason: "WebGPUEngine.IsSupportedAsync returned false",
      diagnostics: { ...secure, isSupportedAsyncResult: false } }, UA.chromeMac));
    expect(advice).toMatchObject({ id: "adapter-blocked", tone: "info" });
    expect(advice?.fix).toContain("chrome://gpu says why, under \"WebGPU\".");
    expect(advice?.fix.join(" ")).not.toMatch(/flag/i);
  });

  it("warns about drawing without the GPU in the browser's own words, whatever renderer was chosen", () => {
    const swiftShader = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
    const [chrome] = adviseRenderer(facts({ mode: "webgl2", requested: "webgl2", diagnostics: secure }, UA.chromeMac, { gpu: swiftShader }));
    expect(chrome).toMatchObject({ id: "software-gl", tone: "warning", text: "The browser draws without the GPU (SwiftShader), so the globe is slow." });
    expect(chrome?.fix[0]).toContain("Settings → System → \"Use graphics acceleration when available\"");
    const [edge] = adviseRenderer(facts({ mode: "webgl2", requested: "auto", diagnostics: secure }, UA.edgeWindows, { gpu: "Microsoft Basic Render Driver" }));
    expect(edge?.fix[0]).toContain("Settings → System and performance");
    expect(ids(facts({ mode: "webgl2", requested: "auto", diagnostics: secure }, UA.firefoxLinux, { gpu: "llvmpipe (LLVM 17.0.6, 256 bits)" }))).toEqual(["software-gl"]);
    expect(ids(facts({ mode: "webgpu", requested: "auto", diagnostics: secure }, UA.chromeMac, { gpu: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)" }))).toEqual([]);
  });

  it("asks for an update where a newer browser has WebGPU, and says when none has it yet", () => {
    const noGpu = { mode: "webgl2" as const, requested: "auto" as const, diagnostics: { navigatorGpuPresent: false, isSupportedAsyncResult: false, isSecureContext: true } };
    expect(adviseRenderer(facts(noGpu, UA.safariIos18))).toEqual([{
      id: "old-browser", tone: "info", text: "The globe draws with WebGL2: iOS has WebGPU from version 26, and this is 18.",
      fix: ["Update iOS to 26 or newer, through the system's software update."],
    }]);
    expect(adviseRenderer(facts(noGpu, UA.firefoxWindows128))[0]?.fix).toEqual(["Update Firefox to version 141 or newer."]);
    expect(adviseRenderer(facts(noGpu, UA.firefoxAndroid))[0]).toMatchObject({ id: "old-browser", fix: ["It arrives with a Firefox update. Chrome on Android has it now."] });
    // A current browser without navigator.gpu: nothing to advise.
    expect(ids(facts(noGpu, UA.safariMac26))).toEqual([]);
  });
});

describe("identifying the browser", () => {
  it("reads the family, version and platform from the user agent, and the brands where given", () => {
    expect(identifyBrowser(UA.chromeAndroid)).toEqual({ family: "chromium", name: "chrome", platform: "android", version: 155 });
    expect(identifyBrowser(UA.edgeWindows)).toEqual({ family: "chromium", name: "edge", platform: "windows", version: 155 });
    expect(identifyBrowser(UA.safariIos18)).toEqual({ family: "safari", name: "safari", platform: "ios", version: 18 });
    expect(identifyBrowser(UA.firefoxLinux)).toEqual({ family: "firefox", name: "firefox", platform: "linux", version: 144 });
    expect(identifyBrowser(UA.chromeMac, { brands: [{ brand: "Chromium", version: "156" }, { brand: "Microsoft Edge", version: "156" }] }))
      .toEqual({ family: "chromium", name: "edge", platform: "macos", version: 156 });
    // Chrome on iOS is WebKit and gives no Safari version.
    expect(identifyBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1"))
      .toEqual({ family: "safari", name: "other", platform: "ios", version: null });
  });
});

describe("advice not shown again", () => {
  it("is saved per id and survives a broken or blocked store", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    expect(readDismissedAdvice(storage)).toEqual(new Set());
    dismissAdvice(storage, "insecure-origin");
    dismissAdvice(storage, "software-gl");
    dismissAdvice(storage, "insecure-origin");
    expect(readDismissedAdvice(storage)).toEqual(new Set(["insecure-origin", "software-gl"]));
    values.set(RENDERER_ADVICE_DISMISSED_STORAGE_KEY, "{not json");
    expect(readDismissedAdvice(storage)).toEqual(new Set());
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => undefined };
    expect(() => dismissAdvice(blocked, "software-gl")).not.toThrow();
  });
});
