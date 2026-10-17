// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRendererHost } from "../src/babylon/browserRenderer.js";
import type { RendererBootstrapHost } from "../src/babylon/createRendererMode.js";
import { RENDERER_FALLBACK_RETRY_MS, RENDERER_FALLBACK_STORAGE_KEY, RENDERER_PREFERENCE_STORAGE_KEY, type RendererFallback } from "../src/rendererPreference.js";
import { SHADER_CHUNKS_ELEMENT_ID } from "../src/shaderChunks.js";

const mockState = vi.hoisted(() => ({
  isSupportedAsync: true,
  webGpuInitAsync: vi.fn(),
  webGpuDispose: vi.fn(),
  webGpuBeginFrame: vi.fn(),
  webGpuEndFrame: vi.fn(),
  webGpuSceneRender: vi.fn(),
  webGpuSceneDispose: vi.fn(),
  webGpuCtor: vi.fn(),
  webGlCtor: vi.fn(),
  webGlDispose: vi.fn(),
  webGl2Available: true,
  probeOk: true,
  probeErrors: [] as string[],
  probeCalls: [] as unknown[],
  sceneDepthModes: [] as boolean[],
}));

vi.mock("@babylonjs/core", () => {
  class MockWebGPUEngine {
    static IsSupportedAsync = Promise.resolve(mockState.isSupportedAsync);
    useReverseDepthBuffer = false;

    initAsync = mockState.webGpuInitAsync;
    dispose = mockState.webGpuDispose;
    beginFrame = mockState.webGpuBeginFrame;
    endFrame = mockState.webGpuEndFrame;
    resize = vi.fn();
    device = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    constructor(_canvas: HTMLCanvasElement, _options: unknown) {
      mockState.webGpuCtor?.(_canvas, _options);
    }
  }

  class MockEngine {
    webGLVersion = 2;
    useReverseDepthBuffer = false;
    dispose = mockState.webGlDispose;

    constructor(canvas: HTMLCanvasElement, ...args: unknown[]) {
      const options = args[1] as { disableWebGL2Support?: boolean };
      this.webGLVersion = options?.disableWebGL2Support || !mockState.webGl2Available ? 1 : 2;
      mockState.webGlCtor(canvas, ...args);
    }
  }

  class MockScene {
    useRightHandedSystem = false;
    clearColor = null;
    activeCamera: MockFreeCamera | null = null;
    render = mockState.webGpuSceneRender;
    dispose = mockState.webGpuSceneDispose;
    constructor(engine: { useReverseDepthBuffer: boolean }) {
      mockState.sceneDepthModes.push(engine.useReverseDepthBuffer);
    }
  }

  class MockFreeCamera {
    constructor(
      public name: string,
      public _position: unknown,
      public scene: MockScene,
    ) {}

    dispose = vi.fn();
  }

  return {
    Engine: MockEngine,
    WebGPUEngine: MockWebGPUEngine,
    Scene: MockScene,
    FreeCamera: MockFreeCamera,
    Vector3: class MockVector3 {
      constructor(
        public x: number,
        public y: number,
        public z: number,
      ) {}
    },
    Color4: class MockColor4 {
      constructor(
        public r: number,
        public g: number,
        public b: number,
        public a: number,
      ) {}
    },
  };
});

vi.mock("../src/babylon/webgpuPresentationProbe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/babylon/webgpuPresentationProbe.js")>();
  return {
    ...actual,
    probeWebGpuPresentation: vi.fn(async (_engine, scene) => {
      mockState.probeCalls.push(scene);
      return {
        ok: mockState.probeOk,
        errors: mockState.probeErrors,
      };
    }),
  };
});

const _lsStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => _lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => { _lsStore.set(k, String(v)); },
  removeItem: (k: string) => { _lsStore.delete(k); },
  clear: () => { _lsStore.clear(); },
  key: (i: number) => Array.from(_lsStore.keys())[i] ?? null,
  get length() { return _lsStore.size; },
});

const savedFallback = (): RendererFallback | null => JSON.parse(window.localStorage.getItem(RENDERER_FALLBACK_STORAGE_KEY) ?? "null") as RendererFallback | null;
/** A fallback saved by this host a day ago, with what is true now. */
function saveFallbackFrom(host: ReturnType<typeof createBrowserRendererHost>, changes: Partial<RendererFallback> = {}): RendererFallback {
  const fallback: RendererFallback = { mode: "webgl2", reason: "presentation probe failed", at: host.now() - 24 * 60 * 60 * 1000,
    ...host.diagnostics(), userAgent: host.userAgent(), ...changes };
  window.localStorage.setItem(RENDERER_FALLBACK_STORAGE_KEY, JSON.stringify(fallback));
  return fallback;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  _lsStore.clear();
  mockState.isSupportedAsync = true;
  mockState.webGl2Available = true;
  mockState.probeOk = true;
  mockState.probeErrors = [];
  mockState.probeCalls = [];
  mockState.sceneDepthModes = [];
  mockState.webGpuInitAsync.mockResolvedValue(undefined);
});

describe("bootstrapGlobeRenderer", () => {
  it.each(["webgl", "webgl2", "webgpu"] as const)("uses reverse depth before creating the %s scene or presentation probe", async force => {
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const { probeWebGpuPresentation } = await import("../src/babylon/webgpuPresentationProbe.js");
    const { renderer } = await bootstrapGlobeRenderer(document.createElement("canvas"), { force, host: createBrowserRendererHost() });
    expect(renderer.engine.useReverseDepthBuffer).toBe(true);
    expect(mockState.sceneDepthModes.length).toBeGreaterThan(0);
    expect(mockState.sceneDepthModes.every(Boolean)).toBe(true);
    for (const [engine] of vi.mocked(probeWebGpuPresentation).mock.calls) {
      expect(engine.useReverseDepthBuffer).toBe(true);
    }
  });
  it("saves a failed WebGPU start as a fallback with its reason, never as the preference", async () => {
    mockState.probeOk = false;
    mockState.probeErrors = ["Requested allocation size (204800) is smaller than the image requires (311296)."];

    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const { probeWebGpuPresentation } = await import("../src/babylon/webgpuPresentationProbe.js");
    const canvas = document.createElement("canvas");
    const { renderer, scene } = await bootstrapGlobeRenderer(canvas, { host: createBrowserRendererHost() });

    expect(renderer.requested).toBe("auto");
    expect(renderer.mode).toBe("webgl2");
    expect(renderer.engine.useReverseDepthBuffer).toBe(true);
    expect(renderer.fallbackReason).toContain("allocation size");
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe(null);
    expect(savedFallback()).toMatchObject({ mode: "webgl2", reason: expect.stringContaining("allocation size") as string,
      at: expect.any(Number) as number, isSecureContext: expect.any(Boolean) as boolean, navigatorGpuPresent: expect.any(Boolean) as boolean,
      userAgent: window.navigator.userAgent });
    expect(mockState.webGpuDispose).toHaveBeenCalled();
    expect(probeWebGpuPresentation).toHaveBeenCalled();
    expect(scene.useRightHandedSystem).toBe(true);
    expect(mockState.webGlCtor).toHaveBeenCalledWith(canvas, true, expect.any(Object), true);
  });

  it.each(["webgl2", "webgl"])("tries WebGPU over a %s preference saved by an earlier version, and replaces it", async saved => {
    window.localStorage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, saved);
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const { renderer } = await bootstrapGlobeRenderer(document.createElement("canvas"), { host: createBrowserRendererHost() });
    expect(renderer.mode).toBe("webgpu");
    expect(renderer.diagnostics?.fromPersistedPreference).toBeUndefined();
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgpu");
  });

  it("starts WebGL from a saved fallback without trying WebGPU while nothing it depended on has changed", async () => {
    const host = createBrowserRendererHost();
    const fallback = saveFallbackFrom(host);
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const { probeWebGpuPresentation } = await import("../src/babylon/webgpuPresentationProbe.js");
    const { renderer } = await bootstrapGlobeRenderer(document.createElement("canvas"), { host });
    expect(renderer).toMatchObject({ requested: "auto", mode: "webgl2", fallbackReason: "presentation probe failed",
      diagnostics: { fromPersistedPreference: true, fallbackSavedAt: fallback.at } });
    expect(mockState.webGpuInitAsync).not.toHaveBeenCalled();
    expect(probeWebGpuPresentation).not.toHaveBeenCalled();
    expect(savedFallback()).toEqual(fallback);
  });

  it.each([
    ["the page has become a secure context", { isSecureContext: false }, { isSecureContext: true }],
    ["navigator.gpu has appeared", { navigatorGpuPresent: false }, { navigatorGpuPresent: true }],
    ["the browser has changed", { userAgent: "Chrome/140" }, {}],
    ["three days have passed", { at: Date.now() - RENDERER_FALLBACK_RETRY_MS - 1 }, {}],
  ] as const)("tries WebGPU again once %s, and forgets the fallback when it starts", async (_case, saved, now) => {
    const browserHost = createBrowserRendererHost();
    const host = { ...browserHost, diagnostics: () => ({ ...browserHost.diagnostics(), ...now }) };
    saveFallbackFrom(host, saved);
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const { renderer } = await bootstrapGlobeRenderer(document.createElement("canvas"), { host });
    expect(renderer.mode).toBe("webgpu");
    expect(savedFallback()).toBe(null);
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgpu");
  });

  it("replaces a stale fallback with a new one when WebGPU fails again", async () => {
    const host = createBrowserRendererHost();
    saveFallbackFrom(host, { at: 0, reason: "old reason" });
    mockState.probeOk = false;
    mockState.probeErrors = ["still no present"];
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const { renderer } = await bootstrapGlobeRenderer(document.createElement("canvas"), { host });
    expect(renderer.mode).toBe("webgl2");
    expect(savedFallback()).toMatchObject({ reason: "still no present" });
    expect(savedFallback()!.at).toBeGreaterThan(0);
  });

  it("draws with antialiasing only when renderer.antialias asks, and says when WebGPU could only start without it", async () => {
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const canvas = document.createElement("canvas");

    const webgl = await bootstrapGlobeRenderer(canvas, { force: "webgl2", antialias: false, host: createBrowserRendererHost() });
    expect(mockState.webGlCtor).toHaveBeenLastCalledWith(canvas, false, expect.anything(), true);
    expect(webgl.renderer).toMatchObject({ antialias: false, devicePixels: true });

    const webgpu = await bootstrapGlobeRenderer(canvas, { force: "webgpu", antialias: false, host: createBrowserRendererHost() });
    expect(webgpu.renderer).toMatchObject({ mode: "webgpu", antialias: false, devicePixels: true });

    // The safe fallback turns both off, whatever was asked.
    const { probeWebGpuPresentation } = await import("../src/babylon/webgpuPresentationProbe.js");
    vi.mocked(probeWebGpuPresentation)
      .mockImplementationOnce(async () => ({ ok: false, errors: ["no present"] }))
      .mockImplementationOnce(async () => ({ ok: true, errors: [] }));
    const safe = await bootstrapGlobeRenderer(canvas, { force: "webgpu", host: createBrowserRendererHost() });
    expect(safe.renderer).toMatchObject({ mode: "webgpu", antialias: false, devicePixels: false });
  });

  it("uses persisted WebGPU with a presentation probe", async () => {
    window.localStorage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, "webgpu");
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const { probeWebGpuPresentation } = await import("../src/babylon/webgpuPresentationProbe.js");
    const canvas = document.createElement("canvas");

    const { renderer } = await bootstrapGlobeRenderer(canvas, { host: createBrowserRendererHost() });

    expect(renderer.mode).toBe("webgpu");
    expect(renderer.diagnostics?.fromPersistedPreference).toBe(true);
    expect(probeWebGpuPresentation).toHaveBeenCalled();
  });

  it("prefers WebGL2 over a persisted WebGPU choice where immersive VR is supported, without persisting it", async () => {
    window.localStorage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, "webgpu");
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const host = { ...createBrowserRendererHost(), webGlRequirement: async () => "immersive VR" };
    const { renderer } = await bootstrapGlobeRenderer(document.createElement("canvas"), { host });
    expect(renderer).toMatchObject({ requested: "auto", mode: "webgl2", fallbackReason: "immersive VR", diagnostics: { webGlRequired: true } });
    expect(renderer.engine.useReverseDepthBuffer).toBe(true);
    expect(mockState.webGpuInitAsync).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgpu");
  });

  it("keeps an explicit WebGPU request on an immersive VR device", async () => {
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const webGlRequirement = vi.fn(async () => "immersive VR");
    const { renderer } = await bootstrapGlobeRenderer(document.createElement("canvas"),
      { force: "webgpu", host: { ...createBrowserRendererHost(), webGlRequirement } });
    expect(renderer.mode).toBe("webgpu");
    expect(webGlRequirement).not.toHaveBeenCalled();
  });

  it("reads immersive VR support from navigator.xr and ignores a failing query", async () => {
    const xr = { isSessionSupported: vi.fn(async (mode: string) => mode === "immersive-vr") };
    Object.defineProperty(window.navigator, "xr", { value: xr, configurable: true });
    try {
      expect(await createBrowserRendererHost().webGlRequirement?.()).toContain("immersive VR");
      xr.isSessionSupported.mockRejectedValueOnce(new Error("blocked"));
      expect(await createBrowserRendererHost().webGlRequirement?.()).toBeNull();
    } finally {
      Reflect.deleteProperty(window.navigator, "xr");
    }
    expect(await createBrowserRendererHost().webGlRequirement?.()).toBeNull();
  });

  describe("on Android, where Chrome answers immersive-vr with true for Cardboard on every phone", () => {
    const phone = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
    const defineNavigator = (values: Record<string, unknown>): void => {
      for (const [key, value] of Object.entries(values)) Object.defineProperty(window.navigator, key, { value, configurable: true });
    };
    const xr = { isSessionSupported: vi.fn(async (mode: string) => mode === "immersive-vr") };
    const reset = (): void => { for (const key of ["xr", "userAgent", "userAgentData"]) Reflect.deleteProperty(window.navigator, key); };

    it("keeps WebGPU on a phone without asking about immersive VR", async () => {
      defineNavigator({ xr, userAgent: phone, userAgentData: { platform: "Android", mobile: true,
        getHighEntropyValues: vi.fn(async () => ({ formFactors: ["Mobile"] })) } });
      try {
        expect(await createBrowserRendererHost().webGlRequirement?.()).toBeNull();
        expect(xr.isSessionSupported).not.toHaveBeenCalled();
        const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
        expect((await bootstrapRenderer(document.createElement("canvas"), { host: createBrowserRendererHost() })).renderer.mode).toBe("webgpu");
      } finally { reset(); }
    });

    it("keeps WebGPU on a phone whose browser hides userAgentData", async () => {
      defineNavigator({ xr, userAgent: phone });
      try { expect(await createBrowserRendererHost().webGlRequirement?.()).toBeNull(); } finally { reset(); }
    });

    it.each([
      ["Chrome on an Android XR headset", phone.replace(" Mobile", ""), ["Desktop", "XR"]],
      ["Meta Quest Browser", "Mozilla/5.0 (Linux; Android 14; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/38.0 Chrome/138.0.0.0 VR Safari/537.36", ["Mobile"]],
      ["Wolvic", "Mozilla/5.0 (Android 12; Mobile VR; rv:121.0) Gecko/121.0 Firefox/121.0 Wolvic/1.7", null],
    ] as const)("asks for WebGL on %s", async (_name, userAgent, formFactors) => {
      defineNavigator({ xr, userAgent, userAgentData: formFactors && { platform: "Android",
        getHighEntropyValues: vi.fn(async () => ({ formFactors })) } });
      try { expect(await createBrowserRendererHost().webGlRequirement?.()).toContain("immersive VR"); } finally { reset(); }
    });
  });

  it("persists WebGPU when presentation probe succeeds on the real scene", async () => {
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const { probeWebGpuPresentation } = await import("../src/babylon/webgpuPresentationProbe.js");
    const canvas = document.createElement("canvas");
    const { renderer, scene } = await bootstrapGlobeRenderer(canvas, { host: createBrowserRendererHost() });

    expect(renderer.mode).toBe("webgpu");
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgpu");
    expect(probeWebGpuPresentation).toHaveBeenCalledTimes(1);
    expect(scene.useRightHandedSystem).toBe(true);
    expect(mockState.webGpuCtor.mock.calls.some(([probeCanvas]) => probeCanvas !== canvas)).toBe(true);
    expect(mockState.webGpuCtor.mock.calls.some(([runtimeCanvas]) => runtimeCanvas === canvas)).toBe(true);
  });

  it("falls back from forced WebGPU and saves the fallback, not a WebGL preference", async () => {
    mockState.probeOk = false;
    mockState.probeErrors = ['[Invalid TextureView "TextureView_SwapChain_ResolveTarget"] is invalid.'];

    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const canvas = document.createElement("canvas");
    const { renderer } = await bootstrapGlobeRenderer(canvas, { force: "webgpu", host: createBrowserRendererHost() });

    expect(renderer.requested).toBe("webgpu");
    expect(renderer.mode).toBe("webgl2");
    expect(renderer.fallbackReason).toContain("TextureView_SwapChain_ResolveTarget");
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe(null);
    expect(savedFallback()?.reason).toContain("TextureView_SwapChain_ResolveTarget");
  });
  it("releases a WebGPU engine when initialization fails, before falling back", async () => {
    mockState.webGpuInitAsync.mockRejectedValueOnce(new Error("initial device rejected"));
    const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
    const result = await bootstrapRenderer(document.createElement("canvas"), { host: createBrowserRendererHost(), force: "webgpu" });
    expect(result.renderer.mode).toBe("webgl2");
    expect(result.renderer.fallbackReason).toContain("initial device rejected");
    expect(mockState.webGpuDispose).toHaveBeenCalledOnce();
  });

  it("disposes the unreturned scene of the compatibility engine-only factory", async () => {
    const { createRendererMode } = await import("../src/babylon/createRendererMode.js");
    const renderer = await createRendererMode(document.createElement("canvas"), { host: createBrowserRendererHost(), force: "webgl2" });
    expect(renderer.mode).toBe("webgl2");
    expect(mockState.webGpuSceneDispose).toHaveBeenCalledOnce();
  });

  it("forces a genuine WebGL1 context even when WebGL2 is available", async () => {
    const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
    const canvas = document.createElement("canvas");
    const result = await bootstrapRenderer(canvas, { host: createBrowserRendererHost(), force: "webgl" });
    expect(result.renderer).toMatchObject({ requested: "webgl", mode: "webgl" });
    expect(mockState.webGlCtor).toHaveBeenCalledWith(canvas, true, expect.objectContaining({ disableWebGL2Support: true }), true);
    expect(mockState.webGpuInitAsync).not.toHaveBeenCalled();
  });

  it.each(["webgl2", "webgl"] as const)("saves nothing for a chosen %s, so Auto starts from WebGPU again", async force => {
    const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
    await bootstrapRenderer(document.createElement("canvas"), { host: createBrowserRendererHost(), force });
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe(null);
    expect(savedFallback()).toBe(null);
    const auto = await bootstrapRenderer(document.createElement("canvas"), { host: createBrowserRendererHost() });
    expect(auto.renderer.mode).toBe("webgpu");
  });

  it("keeps WebGL2 eligible for automatic fallback", async () => {
    mockState.probeOk = false;
    const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
    const result = await bootstrapRenderer(document.createElement("canvas"), { host: createBrowserRendererHost() });
    expect(result.renderer.mode).toBe("webgl2");
    expect(mockState.webGlCtor.mock.calls.every(call => !(call[2] as { disableWebGL2Support?: boolean }).disableWebGL2Support)).toBe(true);
  });

  it("rejects unavailable forced WebGL2 and disposes the unreturned engine", async () => {
    mockState.webGl2Available = false;
    const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
    await expect(bootstrapRenderer(document.createElement("canvas"), { host: createBrowserRendererHost(), force: "webgl2" })).rejects.toThrow("Forced WebGL2 is unavailable");
    expect(mockState.webGlDispose).toHaveBeenCalledOnce();
    expect(mockState.sceneDepthModes).toEqual([]);
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe(null);
  });

  it("retains a working WebGL1 automatic fallback on a WebGL1-only device", async () => {
    mockState.webGl2Available = false;
    mockState.probeOk = false;
    const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
    const result = await bootstrapRenderer(document.createElement("canvas"), { host: createBrowserRendererHost() });
    expect(result.renderer).toMatchObject({ requested: "auto", mode: "webgl" });
    expect(savedFallback()?.mode).toBe("webgl");
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe(null);
  });

  describe("preloads Babylon's shaders in the language of the backend it starts", () => {
    const start = async (options: { force?: "webgpu" | "webgl2" | "webgl"; host?: RendererBootstrapHost } = {}) => {
      const preloadShaders = vi.fn();
      const host = { ...options.host ?? createBrowserRendererHost(), preloadShaders };
      const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
      const { renderer } = await bootstrapRenderer(document.createElement("canvas"), { force: options.force, host });
      return { mode: renderer.mode, languages: preloadShaders.mock.calls.map(([language]) => language as string) };
    };

    it("WGSL for WebGPU, and GLSL for a chosen WebGL", async () => {
      expect(await start()).toEqual({ mode: "webgpu", languages: ["wgsl"] });
      expect(await start({ force: "webgpu" })).toEqual({ mode: "webgpu", languages: ["wgsl"] });
      expect(await start({ force: "webgl2" })).toEqual({ mode: "webgl2", languages: ["glsl"] });
      expect(await start({ force: "webgl" })).toEqual({ mode: "webgl", languages: ["glsl"] });
    });

    it("GLSL alone where WebGL starts without trying WebGPU", async () => {
      const host = createBrowserRendererHost();
      saveFallbackFrom(host);
      expect(await start({ host })).toEqual({ mode: "webgl2", languages: ["glsl"] });
    });

    it("GLSL too when WebGPU cannot present, and starts the backend if the preload throws", async () => {
      mockState.probeOk = false;
      expect(await start()).toEqual({ mode: "webgl2", languages: ["wgsl", "glsl"] });
      const host = { ...createBrowserRendererHost(), preloadShaders: () => { throw new Error("no document"); } };
      const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
      await expect(bootstrapRenderer(document.createElement("canvas"), { force: "webgl2", host })).resolves.toMatchObject({ renderer: { mode: "webgl2" } });
    });
  });
});

describe("the browser host's shader preload", () => {
  const named = (chunks: Record<string, string>) => {
    const element = document.createElement("script");
    element.type = "application/json";
    element.id = SHADER_CHUNKS_ELEMENT_ID;
    element.textContent = JSON.stringify(chunks);
    document.head.append(element);
  };
  const preloads = () => [...document.querySelectorAll<HTMLLinkElement>("link[rel=modulepreload]")].map(link => ({ href: link.getAttribute("href"), crossorigin: link.getAttribute("crossorigin") }));
  beforeEach(() => { document.head.replaceChildren(); });

  it("adds one modulepreload for the chunk a built page names for that language", () => {
    named({ glsl: "/app/assets/babylon-shaders-glsl-a.js", wgsl: "/app/assets/babylon-shaders-wgsl-b.js" });
    const host = createBrowserRendererHost();
    host.preloadShaders!("wgsl");
    host.preloadShaders!("wgsl");
    expect(preloads()).toEqual([{ href: "/app/assets/babylon-shaders-wgsl-b.js", crossorigin: "" }]);
  });

  it("does nothing on a page that names no chunk, as one from the dev server", () => {
    createBrowserRendererHost().preloadShaders!("glsl");
    named({ wgsl: "/assets/babylon-shaders-wgsl-b.js" });
    createBrowserRendererHost().preloadShaders!("glsl");
    expect(preloads()).toEqual([]);
  });
});
