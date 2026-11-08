import type { ParameterSpec } from "@foss-earth/ui/settings";
export { FRAME_PROFILING_IDS, frameProfilingParameters } from "./profiling.js";

export const RENDERER_TAB = "renderer";

/** The most pixels Resolution draws by default per CSS pixel: 0.75 on a 2× display, 0.5 on a 3× one. */
export const DEFAULT_MAX_PIXELS_PER_CSS_PIXEL = 1.5;

export const RENDERER_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: "renderer.backend",
    label: "Renderer",
    description: "The GPU interface that draws the globe. Auto-detect tries WebGPU and falls back to WebGL.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "auto", label: "Auto-detect", shortLabel: "Auto" },
      { id: "webgpu", label: "WebGPU" },
      { id: "webgl2", label: "WebGL2" },
      { id: "webgl", label: "WebGL" },
    ],
    default: "auto",
    defaultReason: "WebGPU where it starts, otherwise the WebGL that last worked on this device.",
    home: { tab: RENDERER_TAB, section: "main", level: "main" },
    appliesLive: false,
    source: "src/engine/babylon/createRendererMode.ts",
  },
  {
    id: "renderer.resolutionScale",
    label: "Resolution",
    description: "Pixels drawn per pixel of the display. Below 1 draws fewer and scales them up: softer, and less GPU work per frame.",
    unit: "ratio",
    kind: "number",
    bounds: () => ({ min: 0.25, max: 2 }),
    step: 0.25,
    scale: "log2",
    alwaysShowTrack: true,
    default: context => context.rendererDevicePixels === false
      ? { value: 1 / Math.max(1, context.devicePixelRatio), derivedFrom: "the safe WebGPU fallback, which draws a pixel per CSS pixel" }
      : context.devicePixelRatio > DEFAULT_MAX_PIXELS_PER_CSS_PIXEL
        ? { value: DEFAULT_MAX_PIXELS_PER_CSS_PIXEL / context.devicePixelRatio, derivedFrom: `${DEFAULT_MAX_PIXELS_PER_CSS_PIXEL} pixels drawn per CSS pixel on this ${context.devicePixelRatio}× display` }
        : { value: 1, derivedFrom: "a pixel drawn per pixel of the display" },
    defaultReason: "At most 1.5 pixels drawn per CSS pixel: 0.75 on a 2× laptop screen and 0.5 on a 3× phone, about half and a quarter of the pixels. Tried on the flight on 8 November 2026 and kept for speed; a display of 1.5× or less draws every pixel.",
    home: { tab: RENDERER_TAB, section: "main", level: "main" },
    appliesLive: true,
    source: "src/engine/babylon/createBabylonRuntime.ts",
  },
  {
    id: "renderer.antialias",
    label: "Antialiasing",
    description: "Smooths the edges of the ground and models with several samples per pixel, where the renderer allows it. Off saves GPU memory and work.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: "Off for speed: no extra samples per pixel to draw and store. Tried on the flight on 8 November 2026 and kept.",
    home: { tab: RENDERER_TAB, section: "main", level: "main" },
    appliesLive: false,
    source: "src/engine/babylon/createRendererMode.ts",
  },
  {
    id: "renderer.frameRateCap",
    label: "Frame rate cap",
    description: "The most frames drawn in a second. A lower cap saves power and heat; frames still come only when something changes.",
    unit: "fps",
    kind: "number",
    named: [{ id: "off", label: "Off" }],
    bounds: () => ({ min: 10, max: 240 }),
    step: 0.25,
    scale: "log2",
    alwaysShowTrack: true,
    default: 60,
    defaultReason: "60 frames a second: a 120 Hz screen draws half as many frames, and a 60 Hz one is not slowed. Tried on the flight on 8 November 2026 and kept.",
    home: { tab: RENDERER_TAB, section: "main", level: "main" },
    appliesLive: true,
    source: "src/engine/babylon/renderScheduler.ts",
  },
  {
    id: "renderer.upscaling",
    label: "Upscaling",
    description: "How a picture drawn below the display's resolution is enlarged: the browser's own scaling, edge-adaptive EASU, or EASU followed by RCAS sharpening.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "off", label: "Off (browser scaling)", shortLabel: "Off" },
      { id: "easu", label: "EASU", shortLabel: "EASU" },
      { id: "easu-rcas", label: "EASU + RCAS", shortLabel: "EASU + RCAS" },
    ],
    default: "off",
    defaultReason: "The browser scales the canvas, which is what the renderer did before this became a parameter.",
    home: { tab: RENDERER_TAB, section: "main", level: "main" },
    appliesLive: true,
    source: "src/babylon/rendererLifecycle.ts",
  },
  {
    id: "renderer.upscalingSharpness",
    label: "Upscaling sharpness",
    description: "How strongly RCAS sharpens an upscaled picture, from the gentlest lobe at 0 to the strongest that stays inside the local contrast at 1.",
    unit: "ratio",
    kind: "number",
    bounds: () => ({ min: 0, max: 1 }),
    step: 0.05,
    alwaysShowTrack: true,
    default: 0.2,
    defaultReason: "A light sharpen, two stops down from the strongest RCAS lobe.",
    home: { tab: RENDERER_TAB, section: "main", level: "all" },
    appliesLive: true,
    source: "src/babylon/rendererLifecycle.ts",
  },
  {
    id: "renderer.dynamicResolution",
    label: "Dynamic resolution",
    description: "Lowers resolution automatically when the GPU falls behind the frame time target, and raises it slowly when spare GPU time returns.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "The resolution drops only while the GPU misses the target frame rate, and comes back once it keeps up. Tried on the flight on 8 November 2026 and kept.",
    home: { tab: RENDERER_TAB, section: "main", level: "main" },
    appliesLive: true,
    source: "src/babylon/rendererLifecycle.ts",
  },
  {
    id: "renderer.targetFps",
    label: "Target frame rate",
    description: "The frame rate dynamic resolution tries to hold, spending about four fifths of each frame on the GPU.",
    unit: "fps",
    kind: "number",
    bounds: () => ({ min: 30, max: 120 }),
    step: 5,
    alwaysShowTrack: true,
    default: 60,
    defaultReason: "A 60 Hz picture, with the GPU budget a little under one frame.",
    home: { tab: RENDERER_TAB, section: "main", level: "all" },
    appliesLive: true,
    visibleWhen: { id: "renderer.dynamicResolution", value: true },
    source: "src/babylon/rendererLifecycle.ts",
  },
  {
    id: "renderer.skipDisabledMeshes",
    label: "Skip hidden meshes",
    description: "Each frame, offers the renderer only the meshes that are switched on, so map tiles kept in memory but not shown cost nothing to pass over. Off, it visits every mesh and skips those itself.",
    unit: "none",
    kind: "boolean",
    default: true,
    defaultReason: "The same picture with less work: the renderer skips a switched-off mesh before drawing anything of it (performance limits audit L8).",
    home: { tab: RENDERER_TAB, section: "main", level: "all" },
    appliesLive: true,
    source: "src/babylon/presentationCandidates.ts",
  },
  {
    id: "renderer.opaqueNearToFar",
    label: "Draw near meshes first",
    description: "Draws the globe's opaque meshes nearest first, so a GPU can skip shading what is already covered, instead of grouped by material, which for map tiles is about the order they loaded. A mesh whose picture could depend on the order, such as the sky dome, keeps its place, and only the meshes between such meshes are reordered.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: "Held for the tolerance test (performance limits audit L24, ledger P-113): with Google tiles it changed 41-61 of 1,024,000 pixels, by up to 8 levels, not all shown to be depth ties, and it gained nothing measurable here, on an Apple GPU or in software rendering.",
    home: { tab: RENDERER_TAB, section: "main", level: "all" },
    appliesLive: true,
    source: "src/babylon/opaqueOrder.ts",
  },
  {
    id: "renderer.clipping",
    label: "Depth range",
    description: "How the globe camera's nearest and farthest drawn distances are set: from its height each frame, or fixed. An app's own cameras, such as a cockpit's, keep theirs.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "automatic", label: "From the camera's height" },
      { id: "fixed", label: "Fixed" },
    ],
    default: "automatic",
    defaultReason: "Babylon's geospatial clipping keeps depth precise from the ground to orbit.",
    home: { tab: RENDERER_TAB, section: "clipping", level: "main" },
    appliesLive: true,
    source: "src/engine/babylon/createBabylonRuntime.ts",
  },
  {
    id: "renderer.clipping.fixed",
    label: "Fixed depth range",
    description: "The nearest and farthest distances drawn when the depth range is fixed. A wide range loses depth precision: far ground can flicker through near.",
    unit: "m",
    kind: "range",
    bounds: () => ({ min: 0.01, max: 1e9 }),
    step: 0.25,
    scale: "log2",
    default: { min: 1, max: 1e7 },
    defaultReason: "From a metre to past the far side of the Earth.",
    home: { tab: RENDERER_TAB, section: "clipping", level: "main" },
    appliesLive: true,
    source: "src/engine/babylon/createBabylonRuntime.ts",
  },
];

/**
 * Changes that should draw the same picture with less work, each off until
 * A/B checks and device trials confirm it (docs/validation/panorama-experiments.md;
 * candidate numbers from docs/webgl-panorama-performance-review.md). `all`
 * holds every other one on while it is on.
 */
export const RENDERER_EXPERIMENT_IDS = {
  all: "renderer.experiments.all",
  sphereBookkeeping: "renderer.experiments.panoramaBookkeeping",
  opaqueImmersion: "renderer.experiments.opaqueImmersion",
  sphereShaders: "renderer.experiments.panoramaShaders",
  presentationCandidates: "renderer.experiments.presentationCandidates",
} as const;

const EXPERIMENT_REASON = "Under A/B validation: meant to draw the same picture with less work, not yet confirmed on devices.";
const experimentHome = { tab: RENDERER_TAB, section: "experiments", level: "main" } as const;

export const RENDERER_EXPERIMENT_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: RENDERER_EXPERIMENT_IDS.all,
    label: "All work-saving experiments",
    description: "Turns on every experiment in this section at once; each stays on while this is.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: EXPERIMENT_REASON,
    home: experimentHome,
    appliesLive: true,
    source: "src/settings/appSettings.ts",
  },
  {
    id: RENDERER_EXPERIMENT_IDS.sphereBookkeeping,
    label: "Panorama draws without test records",
    description: "Stops recording every panorama draw, its camera as text and earlier frames' uniforms, which only the renderer's own checks read; a check turns recording back on. Review candidate 5.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: EXPERIMENT_REASON,
    home: experimentHome,
    appliesLive: true,
    source: "src/engine/babylon/panorama/panoramaRenderer.ts",
  },
  {
    id: RENDERER_EXPERIMENT_IDS.opaqueImmersion,
    label: "Opaque panorama",
    description: "Draws a panorama shown at full opacity without blending it over the frame behind, crossfades between two of its images included; fades from the globe still blend. Review candidate 6.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: EXPERIMENT_REASON,
    home: experimentHome,
    appliesLive: true,
    source: "src/engine/babylon/panorama/panoramaRenderer.ts",
  },
  {
    id: RENDERER_EXPERIMENT_IDS.sphereShaders,
    label: "Simpler panorama shaders",
    description: "WebGL only: works out each orb's per-draw constants once on the CPU instead of in every pixel, turns the panorama's view into the image's frame in the vertex shader, and normalizes each ray once or, for a cube, not at all. Review candidate 7.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: EXPERIMENT_REASON,
    home: experimentHome,
    appliesLive: true,
    source: "src/engine/babylon/panorama/panoramaRenderer.ts",
  },
  {
    id: RENDERER_EXPERIMENT_IDS.presentationCandidates,
    label: "Skip the hidden globe during a panorama",
    description: "While a panorama replaces the globe, offers the renderer only the meshes it can draw, instead of preparing every retained map tile twice a frame before hiding it. Review candidate 3.",
    unit: "none",
    kind: "boolean",
    default: false,
    defaultReason: EXPERIMENT_REASON,
    home: experimentHome,
    appliesLive: true,
    source: "src/engine/babylon/presentationCandidates.ts",
  },
];

/** Generic renderer experiments; 360 supplies its own three legacy feature records. */
export const RENDERER_OWNED_EXPERIMENT_PARAMETERS = RENDERER_EXPERIMENT_PARAMETERS.filter(spec =>
  spec.id === RENDERER_EXPERIMENT_IDS.all || spec.id === RENDERER_EXPERIMENT_IDS.presentationCandidates);
/** Temporary exact-data handoff for 360; register these once in the host, never twice. */
export const LEGACY_360_RENDERER_PARAMETER_HANDOFF = RENDERER_EXPERIMENT_PARAMETERS.filter(spec =>
  spec.id !== RENDERER_EXPERIMENT_IDS.all && spec.id !== RENDERER_EXPERIMENT_IDS.presentationCandidates);
