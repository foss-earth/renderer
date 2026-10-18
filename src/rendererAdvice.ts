import type { RendererSelection } from "./rendererTypes.js";
import type { RendererPreferenceStorage } from "./rendererPreference.js";
import { RENDERER_FALLBACK_RETRY_MS } from "./rendererPreference.js";
import { getRendererLabel } from "./rendererStartNote.js";

/**
 * Advice for a renderer that draws with WebGL on a device that could use WebGPU, each with a concrete
 * fix (docs/proposals/startup-loading.md, section 3). Which browsers ship WebGPU where was checked on
 * 17 October 2026 against the gpuweb wiki's implementation status and the browsers' release notes.
 */
export type RendererAdviceId = "insecure-origin" | "stale-preference" | "software-gl" | "adapter-blocked" | "old-browser";

export interface RendererAdvice {
  id: RendererAdviceId;
  tone: "warning" | "info";
  /** One sentence for the log. */
  text: string;
  /** The steps of the fix, each a sentence. */
  fix: readonly string[];
  docs?: string;
}

export type BrowserFamily = "chromium" | "safari" | "firefox" | "other";
export type BrowserPlatform = "windows" | "macos" | "linux" | "chromeos" | "android" | "ios" | "other";

export interface BrowserIdentity {
  family: BrowserFamily;
  /** The browser's major version; for Safari and other WebKit browsers on iOS, Safari's. Null when unknown. */
  version: number | null;
  platform: BrowserPlatform;
  /** Edge, Opera, Samsung Internet and others name their settings differently from Chrome. */
  name: "chrome" | "edge" | "samsung" | "chromium" | "safari" | "firefox" | "other";
}

export interface RendererFacts {
  renderer: Pick<RendererSelection, "requested" | "mode" | "fallbackReason" | "diagnostics">;
  browser: BrowserIdentity;
  /** The renderer string the engine reports: WebGL's `UNMASKED_RENDERER_WEBGL`, or the WebGPU adapter's. */
  gpu?: string | null;
  hostname: string;
}

interface UserAgentData { brands?: readonly { brand: string; version: string }[]; platform?: string; mobile?: boolean }

const major = (text: string | undefined): number | null => {
  const value = Number.parseInt(text ?? "", 10);
  return Number.isFinite(value) ? value : null;
};

/** The browser, its version and platform, from `navigator.userAgentData` where present, else the user agent. */
export function identifyBrowser(userAgent: string, data?: UserAgentData | null): BrowserIdentity {
  const platform: BrowserPlatform = /iPhone|iPad|iPod/.test(userAgent) ? "ios"
    : /Android/.test(userAgent) ? "android"
      : /CrOS/.test(userAgent) ? "chromeos"
        : /Windows/.test(userAgent) ? "windows"
          : /Macintosh|Mac OS X/.test(userAgent) ? "macos"
            : /Linux|X11/.test(userAgent) ? "linux" : "other";
  // Every browser on iOS is WebKit, so it has Safari's WebGPU.
  if (platform === "ios") return { family: "safari", name: /CriOS|FxiOS|EdgiOS/.test(userAgent) ? "other" : "safari", platform, version: major(userAgent.match(/Version\/(\d+)/)?.[1]) };
  const brands = data?.brands ?? [];
  const brand = (name: string): number | null => major(brands.find(entry => entry.brand === name)?.version);
  const chromium = brand("Chromium") ?? major(userAgent.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1]);
  if (/Firefox\/(\d+)/.test(userAgent) && chromium === null) return { family: "firefox", name: "firefox", platform, version: major(userAgent.match(/Firefox\/(\d+)/)?.[1]) };
  if (chromium !== null) {
    const name = brand("Microsoft Edge") !== null || /Edg\//.test(userAgent) ? "edge"
      : /SamsungBrowser/.test(userAgent) ? "samsung"
        : brand("Google Chrome") !== null || (/Chrome\//.test(userAgent) && !/OPR\/|Vivaldi|Brave/.test(userAgent)) ? "chrome" : "chromium";
    return { family: "chromium", name, platform, version: chromium };
  }
  if (/Safari\//.test(userAgent) && /Version\/(\d+)/.test(userAgent)) return { family: "safari", name: "safari", platform, version: major(userAgent.match(/Version\/(\d+)/)?.[1]) };
  return { family: "other", name: "other", platform, version: null };
}

/**
 * The version from which a browser has WebGPU on by default on this platform: a number, "some" for a
 * platform where it has it on some GPUs only, or null where no version has it yet.
 */
function webGpuSince({ family, platform }: BrowserIdentity): number | "some" | null {
  if (family === "chromium") {
    if (platform === "windows" || platform === "macos" || platform === "chromeos") return 113;
    if (platform === "android") return 121;
    // Chrome 144 on Intel Gen12 and newer, 147 on recent NVIDIA drivers under Wayland; others behind a flag.
    if (platform === "linux") return "some";
    return null;
  }
  if (family === "safari") return platform === "ios" || platform === "macos" ? 26 : null;
  if (family === "firefox") {
    if (platform === "windows") return 141;
    // Apple silicon on macOS 26 and newer; the user agent does not say which Mac it is.
    if (platform === "macos") return 145;
    return null;
  }
  return null;
}

const SOFTWARE = /SwiftShader|llvmpipe|softpipe|lavapipe|Software Rasterizer|Basic Render Driver|\bSoftware\b/i;
const PRIVATE_HOST = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)|\.local$|^\[?fe80:/i;
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const WEBGPU_ON_A_PHONE_DOCS = "https://github.com/foss-earth/docs/blob/main/docs/development.md#webgpu-on-a-phone";

function accelerationSetting(browser: BrowserIdentity): string {
  if (browser.name === "edge") return "In Edge: Settings → System and performance → \"Use graphics acceleration when available\", then relaunch Edge.";
  if (browser.family === "firefox") return "In Firefox: Settings → General → Performance, clear \"Use recommended performance settings\", tick \"Use hardware acceleration when available\", then restart Firefox.";
  if (browser.family === "chromium") return "In Chrome: Settings → System → \"Use graphics acceleration when available\", then relaunch Chrome.";
  return "Turn on the browser's graphics or hardware acceleration in its settings, then restart it.";
}

/**
 * What to tell a visitor about the renderer that started, most useful first; empty when WebGPU runs,
 * when WebGL was chosen, or when the device needs WebGL, such as a headset.
 */
export function adviseRenderer({ renderer, browser, gpu, hostname }: RendererFacts): RendererAdvice[] {
  const { mode, requested, diagnostics } = renderer;
  const advice: RendererAdvice[] = [];
  const label = getRendererLabel(mode);
  const software = gpu?.match(SOFTWARE)?.[0];
  if (software) {
    advice.push({
      id: "software-gl", tone: "warning",
      text: `The browser draws without the GPU (${software}), so the globe is slow.`,
      fix: [accelerationSetting(browser), "If it is on already, update the graphics driver."],
    });
  }
  if (mode === "webgpu" || (requested !== "auto" && requested === mode) || !diagnostics || diagnostics.webGlRequired) return advice;
  const since = webGpuSince(browser);
  if (!diagnostics.isSecureContext) {
    if (since === null) return advice;
    const devServer = PRIVATE_HOST.test(hostname);
    advice.push({
      id: "insecure-origin", tone: "warning",
      text: `The globe draws with ${label} because WebGPU needs a secure page (HTTPS or localhost), and this one is not.`,
      fix: devServer
        ? ["This is a development server's address: connect the phone by USB and forward the port, or mark this origin as secure in Chrome's flags, as the guide says."]
        : [`Open this page's https:// address instead (https://${hostname}).`],
      ...(devServer ? { docs: WEBGPU_ON_A_PHONE_DOCS } : {}),
    });
    return advice;
  }
  if (diagnostics.fallbackSavedAt !== undefined && diagnostics.navigatorGpuPresent) {
    advice.push({
      id: "stale-preference", tone: "warning",
      text: `The globe draws with ${label} because WebGPU failed here on ${day(diagnostics.fallbackSavedAt)}.`,
      fix: [`WebGPU is tried again from ${day(diagnostics.fallbackSavedAt + RENDERER_FALLBACK_RETRY_MS)}, or sooner if the browser changes.`, "To try it now: Settings → Renderer → WebGPU."],
    });
    return advice;
  }
  if (diagnostics.navigatorGpuPresent && diagnostics.isSupportedAsyncResult === false) {
    advice.push({
      id: "adapter-blocked", tone: "info",
      text: `The globe draws with ${label} because the browser does not offer WebGPU on this GPU or driver.`,
      fix: [
        "Updating the graphics driver or the browser can add it.",
        ...(browser.family === "chromium" ? ["chrome://gpu says why, under \"WebGPU\"."] : browser.family === "firefox" ? ["about:support says why, under \"Graphics\"."] : []),
      ],
    });
    return advice;
  }
  if (!diagnostics.navigatorGpuPresent) {
    const name = browser.family === "safari" ? (browser.platform === "ios" ? "iOS" : "Safari") : browser.family === "firefox" ? "Firefox" : "the browser";
    if (typeof since === "number" && browser.version !== null && browser.version < since) {
      advice.push({
        id: "old-browser", tone: "info",
        text: `The globe draws with ${label}: ${name} has WebGPU from version ${since}, and this is ${browser.version}.`,
        fix: [browser.family === "safari" ? `Update ${name} to 26 or newer, through the system's software update.` : `Update ${name} to version ${since} or newer.`],
      });
    } else if (browser.family === "firefox" && since === null) {
      advice.push({
        id: "old-browser", tone: "info",
        text: `The globe draws with ${label}: Firefox does not have WebGPU on by default here yet.`,
        fix: [`It arrives with a Firefox update. ${browser.platform === "android" ? "Chrome on Android has it now." : browser.platform === "linux" ? "Chrome on Linux has it on some GPUs." : "Chrome has it on most platforms."}`],
      });
    }
  }
  return advice;
}

export const RENDERER_ADVICE_DISMISSED_STORAGE_KEY = "foss-earth:renderer-advice-dismissed";

/** The advice a visitor asked not to see again in the log. */
export function readDismissedAdvice(storage: Pick<RendererPreferenceStorage, "getItem">): Set<string> {
  try {
    const value: unknown = JSON.parse(storage.getItem(RENDERER_ADVICE_DISMISSED_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function dismissAdvice(storage: RendererPreferenceStorage, id: string): void {
  const dismissed = readDismissedAdvice(storage);
  dismissed.add(id);
  try { storage.setItem(RENDERER_ADVICE_DISMISSED_STORAGE_KEY, JSON.stringify([...dismissed])); } catch { /* the advice comes back next time */ }
}
