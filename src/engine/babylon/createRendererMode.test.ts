// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RENDERER_PREFERENCE_STORAGE_KEY } from "./rendererPreference";

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
  probeOk: true,
  probeErrors: [] as string[],
  probeCalls: [] as unknown[],
}));

vi.mock("@babylonjs/core", () => {
  class MockWebGPUEngine {
    static IsSupportedAsync = Promise.resolve(mockState.isSupportedAsync);

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

    constructor(canvas: HTMLCanvasElement, ...args: unknown[]) {
      mockState.webGlCtor(canvas, ...args);
    }
  }

  class MockScene {
    useRightHandedSystem = false;
    clearColor = null;
    activeCamera: MockFreeCamera | null = null;
    render = mockState.webGpuSceneRender;
    dispose = mockState.webGpuSceneDispose;
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

vi.mock("./webgpuPresentationProbe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./webgpuPresentationProbe")>();
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
  mockState.probeOk = true;
  mockState.probeErrors = [];
  mockState.probeCalls = [];
  mockState.webGpuInitAsync.mockResolvedValue(undefined);
});

describe("bootstrapGlobeRenderer", () => {
  it("persists WebGL2 when WebGPU presentation probe fails in auto mode", async () => {
    mockState.probeOk = false;
    mockState.probeErrors = ["Requested allocation size (204800) is smaller than the image requires (311296)."];

    const { bootstrapGlobeRenderer } = await import("./createRendererMode");
    const { probeWebGpuPresentation } = await import("./webgpuPresentationProbe");
    const canvas = document.createElement("canvas");
    const { renderer, scene } = await bootstrapGlobeRenderer(canvas);

    expect(renderer.requested).toBe("auto");
    expect(renderer.mode).toBe("webgl2");
    expect(renderer.fallbackReason).toContain("allocation size");
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgl2");
    expect(mockState.webGpuDispose).toHaveBeenCalled();
    expect(probeWebGpuPresentation).toHaveBeenCalled();
    expect(scene.useRightHandedSystem).toBe(true);
    expect(mockState.webGlCtor).toHaveBeenCalledWith(canvas, true, expect.any(Object), true);
  });

  it("uses persisted WebGL2 without attempting WebGPU", async () => {
    window.localStorage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, "webgl2");
    const { bootstrapGlobeRenderer } = await import("./createRendererMode");
    const { probeWebGpuPresentation } = await import("./webgpuPresentationProbe");
    const canvas = document.createElement("canvas");

    const { renderer } = await bootstrapGlobeRenderer(canvas);

    expect(renderer.mode).toBe("webgl2");
    expect(renderer.diagnostics?.fromPersistedPreference).toBe(true);
    expect(mockState.webGpuInitAsync).not.toHaveBeenCalled();
    expect(probeWebGpuPresentation).not.toHaveBeenCalled();
  });

  it("uses persisted WebGPU with a presentation probe", async () => {
    window.localStorage.setItem(RENDERER_PREFERENCE_STORAGE_KEY, "webgpu");
    const { bootstrapGlobeRenderer } = await import("./createRendererMode");
    const { probeWebGpuPresentation } = await import("./webgpuPresentationProbe");
    const canvas = document.createElement("canvas");

    const { renderer } = await bootstrapGlobeRenderer(canvas);

    expect(renderer.mode).toBe("webgpu");
    expect(renderer.diagnostics?.fromPersistedPreference).toBe(true);
    expect(probeWebGpuPresentation).toHaveBeenCalled();
  });

  it("persists WebGPU when presentation probe succeeds on the real scene", async () => {
    const { bootstrapGlobeRenderer } = await import("./createRendererMode");
    const { probeWebGpuPresentation } = await import("./webgpuPresentationProbe");
    const canvas = document.createElement("canvas");
    const { renderer, scene } = await bootstrapGlobeRenderer(canvas);

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

    const { bootstrapGlobeRenderer } = await import("./createRendererMode");
    const canvas = document.createElement("canvas");
    const { renderer } = await bootstrapGlobeRenderer(canvas, { force: "webgpu" });

    expect(renderer.requested).toBe("webgpu");
    expect(renderer.mode).toBe("webgl2");
    expect(renderer.fallbackReason).toContain("TextureView_SwapChain_ResolveTarget");
    expect(window.localStorage.getItem(RENDERER_PREFERENCE_STORAGE_KEY)).toBe("webgl2");
  });
});
