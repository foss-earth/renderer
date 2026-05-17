import { Engine, type EngineOptions, WebGPUEngine } from "@babylonjs/core";

export type RendererMode = "webgpu" | "webgl";

export interface RendererSelection {
  requested: "webgpu";
  mode: RendererMode;
  engine: Engine | WebGPUEngine;
}

export interface RendererModeOptions {
  forceWebGl?: boolean;
}

const WEBGL_ENGINE_OPTIONS: EngineOptions = {
  preserveDrawingBuffer: false,
  stencil: true,
  useLargeWorldRendering: true,
};

function createWebGlEngine(canvas: HTMLCanvasElement): Engine {
  return new Engine(canvas, true, WEBGL_ENGINE_OPTIONS, true);
}

export async function createRendererMode(
  canvas: HTMLCanvasElement,
  options: RendererModeOptions = {},
): Promise<RendererSelection> {
  if (options.forceWebGl) {
    return {
      requested: "webgpu",
      mode: "webgl",
      engine: createWebGlEngine(canvas),
    };
  }

  try {
    const webGpuSupported = await WebGPUEngine.IsSupportedAsync;
    if (webGpuSupported) {
      const webGpuEngine = new WebGPUEngine(canvas, {
        antialias: true,
        adaptToDeviceRatio: true,
        useLargeWorldRendering: true,
      });
      await webGpuEngine.initAsync();

      return {
        requested: "webgpu",
        mode: "webgpu",
        engine: webGpuEngine,
      };
    }
  } catch (error) {
    console.warn("WebGPU initialization failed. Falling back to WebGL.", error);
  }

  return {
    requested: "webgpu",
    mode: "webgl",
    engine: createWebGlEngine(canvas),
  };
}
