import type { ParameterHome, ParameterSpec } from "@foss-earth/ui/settings";

/**
 * Frame profiling, for the frame budget panel. Measuring costs a little on
 * every frame and a trace holds memory, so both are off by default and last
 * for this session only. They are not in FOSS Earth's catalogue: each app
 * registers them once, homed where its panel is, since the panel is their
 * one home (FOSS Earth: Renderer → Performance debug; 0SFS: Debug → Frame budget).
 */
export { FRAME_PROFILING_IDS } from "../profiling/ids.js";
import { FRAME_PROFILING_IDS } from "../profiling/ids.js";

const SOURCE = "src/perf/frameProfileSession.ts";
const PANEL = "src/shell/frameBudgetPanel.ts";

export function frameProfilingParameters(home: Omit<ParameterHome, "level">): ParameterSpec[] {
  return [
    {
      id: FRAME_PROFILING_IDS.enabled,
      label: "Measure frame time",
      description: "Times each section of every frame, and the GPU's work where the renderer can, for the frame budget table.",
      unit: "none",
      kind: "boolean",
      default: false,
      defaultReason: "Measuring adds a little work to every frame, so it runs only when asked.",
      home: { ...home, level: "main" },
      appliesLive: true,
      session: true,
      source: SOURCE,
    },
    {
      id: FRAME_PROFILING_IDS.windowFrames,
      label: "Frames summarised",
      description: "How many of the latest frames the table's means and percentiles cover. Changing it starts a fresh window.",
      unit: "count",
      kind: "number",
      bounds: () => ({ min: 1, max: 36_000 }),
      scale: "log2",
      step: 0.25,
      default: 600,
      defaultReason: "Ten seconds at 60 fps, as 0SFS's frame budget has always kept.",
      home: { ...home, level: "main" },
      appliesLive: true,
      session: true,
      source: SOURCE,
    },
    {
      id: FRAME_PROFILING_IDS.refreshMs,
      label: "Table refresh",
      description: "How often the table is summarised again while it is shown.",
      unit: "ms",
      kind: "number",
      bounds: () => ({ min: 100, max: 5000 }),
      scale: "log2",
      step: 0.25,
      default: 500,
      defaultReason: "Twice a second, as 0SFS's frame budget has always refreshed.",
      home: { ...home, level: "all" },
      appliesLive: true,
      session: true,
      source: PANEL,
    },
    {
      id: FRAME_PROFILING_IDS.traceFrames,
      label: "Frames traced",
      description: "How many of the latest frames are kept whole, every section and interval, to save as a trace. 0 keeps none.",
      unit: "count",
      kind: "number",
      bounds: () => ({ min: 0, max: 36_000 }),
      step: 1,
      default: 0,
      defaultReason: "A trace holds memory for every frame it keeps, so none is kept unless asked.",
      home: { ...home, level: "main" },
      appliesLive: true,
      session: true,
      source: SOURCE,
    },
  ];
}
