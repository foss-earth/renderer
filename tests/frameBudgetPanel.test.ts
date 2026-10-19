// @vitest-environment jsdom
import { Observable, type AbstractEngine, type Scene } from "@babylonjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameProfiler } from "../src/profiling/frameProfiler.js";
import { bindFrameProfileSettings, createFrameProfileSession } from "../src/babylon/frameProfileSession.js";
import { FRAME_PROFILING_IDS, frameProfilingParameters } from "../src/settings/profiling.js";
import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { createFrameBudgetPanel as createInjectedFrameBudgetPanel } from "../src/panel/frameBudgetPanel.js";

import { createIconButton, createParameterControl } from "@foss-earth/ui/browser";

let hostTime = 0;
const hostListeners = new Set<() => void>();
const hostRefresh = { nowMs: () => hostTime, subscribe(listener: () => void) { hostListeners.add(listener); return () => { hostListeners.delete(listener); }; } };
const advanceHost = (ms: number) => { hostTime += ms; for (const listener of [...hostListeners]) listener(); };
const output = { copy: vi.fn(), saveJson: vi.fn() };
function createFrameBudgetPanel(options: Omit<Parameters<typeof createInjectedFrameBudgetPanel>[0], "ui" | "refreshPort" | "actions">) {
  return createInjectedFrameBudgetPanel({ ...options, ui: { document, createParameterControl: (settings, id) => createParameterControl(settings, id, document), createIconButton: options => createIconButton(document, options) }, refreshPort: hostRefresh, actions: output });
}

beforeEach(() => {
  // jsdom has no 2D canvas; the streamgraphs draw nothing then and keep their legends.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  hostListeners.clear(); hostTime = 0; output.copy.mockClear(); output.saveJson.mockClear();
});

function setup() {
  const observable = () => new Observable<Scene>();
  const scene = {
    onBeforeAnimationsObservable: observable(), onAfterRenderObservable: observable(),
    onBeforeActiveMeshesEvaluationObservable: observable(), onAfterActiveMeshesEvaluationObservable: observable(),
    onBeforeRenderTargetsRenderObservable: observable(), onAfterRenderTargetsRenderObservable: observable(),
    onBeforeDrawPhaseObservable: observable(), onAfterDrawPhaseObservable: observable(),
  } as unknown as Scene;
  let time = 0;
  const profiler = createFrameProfiler({ now: () => time });
  const session = createFrameProfileSession({ scene, engine: { getCaps: () => ({}) } as unknown as AbstractEngine, profiler });
  const settings = createSettingsRegistry({ storage: null });
  settings.register(frameProfilingParameters({ tab: "renderer", section: "performance" }));
  const unbind = bindFrameProfileSettings(settings, session);
  const frames = (count: number, work: number) => {
    for (let frame = 0; frame < count; frame++) {
      session.frame(time);
      const started = profiler.clock();
      time += work;
      profiler.add("map/raster tiles", started);
      time += 16 - work;
    }
    session.frame(time);
  };
  return { session, settings, unbind, frames, idle: (ms: number) => { time += ms; } };
}

describe("frame budget panel", () => {
  it("is the home of the profiling controls, and says what is not measured rather than 0", () => {
    const { session, settings, unbind } = setup();
    const panel = createFrameBudgetPanel({ session, settings });
    document.body.append(panel.element);
    const ids = [...panel.element.querySelectorAll<HTMLElement>("[data-parameter]")].map(node => node.dataset.parameter);
    for (const id of Object.values(FRAME_PROFILING_IDS)) expect(ids).toContain(id);
    const status = panel.element.querySelector(".foss-earth-frame-budget__status")!.textContent!;
    expect(status).toContain("Not measuring");
    expect(status).toContain("GPU time: not available");
    expect(panel.element.querySelector<HTMLElement>(".foss-earth-frame-budget__results")!.hidden).toBe(true);
    panel.destroy();
    unbind();
  });

  it("draws a host's title first in the controls row", () => {
    const { session, settings, unbind } = setup();
    const panel = createFrameBudgetPanel({ session, settings, title: "Frame budget" });
    const row = panel.element.firstElementChild!;
    expect(row.firstElementChild!.textContent).toBe("Frame budget");
    expect(row.querySelector("[data-parameter]")).not.toBeNull();
    panel.destroy();
    unbind();
  });

  it("shows each section's mean, p95, p99 and share once measuring, and saves a trace only when one is kept", () => {
    const { session, settings, unbind, frames } = setup();
    const panel = createFrameBudgetPanel({ session, settings, unmeasured: "the browser's own work" });
    document.body.append(panel.element);
    settings.set(FRAME_PROFILING_IDS.enabled, true);
    frames(10, 4);
    advanceHost(500);
    const results = panel.element.querySelector<HTMLElement>(".foss-earth-frame-budget__results")!;
    expect(results.hidden).toBe(false);
    expect(results.textContent).toContain("the other");
    expect(results.textContent).toContain("the browser's own work");
    const headings = [...panel.element.querySelectorAll("thead th")].map(node => node.textContent);
    expect(headings).toEqual(["Section", "Mean ms", "p95 ms", "p99 ms", "Max ms", "Of frame"]);
    const rows = [...panel.element.querySelectorAll("tbody tr")].map(row => row.querySelector("th")!.textContent);
    // The panel's own summarising is work in the frame too, so it shows.
    expect(rows).toEqual(["map", "raster tiles", "profiler", "panel"]);
    const save = [...panel.element.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Save trace")!;
    expect(save.hidden).toBe(true);
    settings.set(FRAME_PROFILING_IDS.traceFrames, 100);
    frames(3, 4);
    panel.refresh();
    expect(save.hidden).toBe(false);
    expect(panel.element.querySelector(".foss-earth-frame-budget__status")!.textContent).toMatch(/trace keeps 3 of 100 frames/);
    panel.destroy();
    unbind();
    session.dispose();
  });

  it("shows a value set elsewhere, such as by a script", () => {
    const { session, settings, unbind } = setup();
    const panel = createFrameBudgetPanel({ session, settings });
    document.body.append(panel.element);
    const measure = panel.element.querySelector<HTMLInputElement>(`[data-parameter="${FRAME_PROFILING_IDS.enabled}"] input`)!;
    expect(measure.checked).toBe(false);
    settings.set(FRAME_PROFILING_IDS.enabled, true);
    expect(measure.checked).toBe(true);
    panel.destroy();
    unbind();
    session.dispose();
  });

  it("stops summarising when measuring stops or the panel goes", () => {
    const { session, settings, unbind } = setup();
    const summary = vi.spyOn(session.profiler, "summary");
    const panel = createFrameBudgetPanel({ session, settings });
    document.body.append(panel.element);
    settings.set(FRAME_PROFILING_IDS.enabled, true);
    summary.mockClear();
    advanceHost(500); advanceHost(500);
    expect(summary).toHaveBeenCalledTimes(2);
    settings.set(FRAME_PROFILING_IDS.enabled, false);
    summary.mockClear();
    advanceHost(1000);
    expect(summary).not.toHaveBeenCalled();
    settings.set(FRAME_PROFILING_IDS.enabled, true);
    panel.destroy();
    summary.mockClear();
    advanceHost(1000);
    expect(summary).not.toHaveBeenCalled();
    unbind();
    session.dispose();
  });
  it("does no hidden refresh or private timer work and releases its host subscription", () => {
    const { session, settings, unbind, frames } = setup();
    const interval = vi.spyOn(window, "setInterval");
    const panel = createFrameBudgetPanel({ session, settings });
    const details = document.createElement("details"); details.append(panel.element); document.body.append(details);
    settings.set(FRAME_PROFILING_IDS.enabled, true); frames(3, 4);
    const summary = vi.spyOn(session.profiler, "summary"); summary.mockClear();
    advanceHost(500); expect(summary).not.toHaveBeenCalled();
    details.open = true; advanceHost(500); expect(summary).toHaveBeenCalledOnce();
    expect(interval).not.toHaveBeenCalled(); expect(hostListeners.size).toBe(1);
    panel.destroy(); panel.destroy(); expect(hostListeners.size).toBe(0);
    summary.mockClear(); advanceHost(500); expect(summary).not.toHaveBeenCalled();
    interval.mockRestore(); unbind(); session.dispose();
  });
  it("draws the streamgraphs while measuring, and moves them on a refresh while no frame comes", () => {
    const { session, settings, unbind, frames, idle } = setup();
    const panel = createFrameBudgetPanel({ session, settings });
    document.body.append(panel.element);
    settings.set(FRAME_PROFILING_IDS.enabled, true);
    frames(20, 4);
    advanceHost(500);
    const charts = [...panel.element.querySelectorAll<HTMLElement>(".foss-earth-streams__chart")];
    expect(charts.map(chart => chart.dataset.resource)).toEqual(["cpu", "gpu", "vram", "ram", "network"]);
    const cpu = charts[0];
    expect(cpu.querySelector("figcaption")!.textContent).toMatch(/^CPU: [\d.]+ ms\/s now, \d+ frames\/s$/);
    expect(cpu.textContent).toContain("map/raster tiles");
    expect(charts[3].querySelector("figcaption")!.textContent).toBe("Memory: not available");
    const samples = session.streams.stream("cpu").ends.length;
    // The first refresh closes the sample the last frames were in; the next has none.
    idle(1000); advanceHost(500);
    idle(1000); advanceHost(500);
    expect(session.streams.stream("cpu").ends.length).toBe(samples + 2);
    expect(cpu.querySelector("figcaption")!.textContent).toMatch(/now, 0 frames\/s$/);
    panel.destroy();
    expect(panel.element.isConnected).toBe(false);
    unbind();
    session.dispose();
  });

  it("sends budget/trace JSON through host output ports", () => {
    const { session, settings, unbind, frames } = setup();
    const panel = createFrameBudgetPanel({ session, settings, traceFileName: "host-trace" }); document.body.append(panel.element);
    settings.set(FRAME_PROFILING_IDS.enabled, true); settings.set(FRAME_PROFILING_IDS.traceFrames, 2); frames(3, 4); panel.refresh();
    for (const button of panel.element.querySelectorAll("button")) if (button.getAttribute("aria-label") === "Copy frame budget" || button.getAttribute("aria-label") === "Save trace") button.click();
    expect(output.copy).toHaveBeenCalledWith(JSON.stringify(session.profiler.summary(), null, 2));
    expect(output.saveJson).toHaveBeenCalledWith("host-trace.json", JSON.stringify(session.trace(), null, 1));
    panel.destroy(); unbind(); session.dispose();
  });
});
