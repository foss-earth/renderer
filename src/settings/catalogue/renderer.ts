import type { ParameterSpec } from "../types";

export const RENDERER_TAB = "renderer";

export const RENDERER_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: "renderer.backend",
    label: "Renderer",
    description: "The GPU interface that draws the globe. Auto-detect tries WebGPU and falls back to WebGL.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "auto", label: "Auto-detect" },
      { id: "webgpu", label: "WebGPU" },
      { id: "webgl2", label: "WebGL2" },
      { id: "webgl", label: "WebGL" },
    ],
    default: "auto",
    defaultReason: "WebGPU where it starts, otherwise the WebGL that last worked on this device.",
    home: { tab: RENDERER_TAB, section: "backend", level: "main" },
    appliesLive: false,
    source: "src/engine/babylon/createRendererMode.ts",
  },
];
