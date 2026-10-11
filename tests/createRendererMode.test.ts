// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRendererHost } from "../src/babylon/browserRenderer.js";
import { RENDERER_PREFERENCE_STORAGE_KEY } from "../src/rendererPreference.js";

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
  it("persists WebGL2 when WebGPU presentation probe fails in auto mode", async () => {
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
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgl2");
    expect(mockState.webGpuDispose).toHaveBeenCalled();
    expect(probeWebGpuPresentation).toHaveBeenCalled();
    expect(scene.useRightHandedSystem).toBe(true);
    expect(mockState.webGlCtor).toHaveBeenCalledWith(canvas, true, expect.any(Object), true);
  });

  it("uses persisted WebGL2 without attempting WebGPU", async () => {
    window.localStorage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, "webgl2");
    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const { probeWebGpuPresentation } = await import("../src/babylon/webgpuPresentationProbe.js");
    const canvas = document.createElement("canvas");

    const { renderer } = await bootstrapGlobeRenderer(canvas, { host: createBrowserRendererHost() });

    expect(renderer.mode).toBe("webgl2");
    expect(renderer.diagnostics?.fromPersistedPreference).toBe(true);
    expect(mockState.webGpuInitAsync).not.toHaveBeenCalled();
    expect(probeWebGpuPresentation).not.toHaveBeenCalled();
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

  it("falls back from forced WebGPU and persists WebGL2", async () => {
    mockState.probeOk = false;
    mockState.probeErrors = ['[Invalid TextureView "TextureView_SwapChain_ResolveTarget"] is invalid.'];

    const { bootstrapGlobeRenderer } = await import("../src/babylon/createRendererMode.js");
    const canvas = document.createElement("canvas");
    const { renderer } = await bootstrapGlobeRenderer(canvas, { force: "webgpu", host: createBrowserRendererHost() });

    expect(renderer.requested).toBe("webgpu");
    expect(renderer.mode).toBe("webgl2");
    expect(renderer.fallbackReason).toContain("TextureView_SwapChain_ResolveTarget");
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgl2");
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
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgl");
    expect(mockState.webGpuInitAsync).not.toHaveBeenCalled();
  });

  it("honors a saved WebGL1 preference without probing WebGPU", async () => {
    window.localStorage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, "webgl");
    const { bootstrapRenderer } = await import("../src/babylon/createRendererMode.js");
    const canvas = document.createElement("canvas");
    const result = await bootstrapRenderer(canvas, { host: createBrowserRendererHost() });
    expect(result.renderer).toMatchObject({ requested: "auto", mode: "webgl", diagnostics: { fromPersistedPreference: true } });
    expect(mockState.webGlCtor).toHaveBeenCalledWith(canvas, true, expect.objectContaining({ disableWebGL2Support: true }), true);
    expect(mockState.webGpuInitAsync).not.toHaveBeenCalled();
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
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgl");
  });

});
