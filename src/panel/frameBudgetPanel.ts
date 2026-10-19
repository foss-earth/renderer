import type { FrameProfileSummary, FrameSectionStats } from "../profiling/frameProfiler.js";
import type { FrameProfileSession, GpuTimingStatus } from "../profiling/frameProfileSession.js";
import { FRAME_PROFILING_IDS } from "../profiling/ids.js";
import { createResourceStreamsView } from "./resourceStreamsView.js";
import type { SettingsRegistry } from "@foss-earth/ui/settings";
export interface FrameBudgetControl { element: HTMLElement; update(): void; destroy(): void }

export interface FrameBudgetPanelOptions {
  /** The runtime's `frameProfile`. */
  session: FrameProfileSession;
  /** The one host registry, with `frameProfilingParameters` registered once. */
  settings: SettingsRegistry;
  ui: {
    document: Document;
    createParameterControl(settings: SettingsRegistry, id: string): FrameBudgetControl;
    /** UI's familiar icon action, with its full accessible name and hover title. */
    createIconButton(options: { icon: "copy" | "download"; label: string }): HTMLButtonElement;
  };
  /** Host UI/frame refresh; never a panel-owned timer or rendering authority. */
  refreshPort: { nowMs(): number; subscribe(listener: () => void): () => void };
  /** Host output policy; clipboard/download globals are not accessed. */
  actions: { copy(text: string): void | Promise<void>; saveJson(name: string, text: string): void | Promise<void>; onError?(error: unknown): void };
  isVisible?(): boolean;
  /** What frame time no section claims is, in this app: ends "the other 4.2 ms is …". */
  unmeasured?: string;
  /** Sentences under the table, such as what a host's sections leave out. */
  notes?: readonly string[];
  /** Parameters whose readings show beside the timings, such as memory in use. */
  readings?: readonly string[];
  /** Added to the root's class, for a host's styling. */
  className?: string;
  /** The panel's title, drawn first in its controls row: "Frame budget [Measure] …". */
  title?: string;
  /** Name for a saved trace; "frame-trace" when omitted. */
  traceFileName?: string;
}

export interface FrameBudgetPanelHandle {
  element: HTMLElement;
  /** Summarises again now, as the supplied refresh subscription does while shown. */
  refresh(): void;
  destroy(): void;
}

const BYTES_PER_KIB = 1024;
/** A row's indent per nesting level, and at the edge, in CSS px. */
const INDENT_PX = 12;
const EDGE_PX = 4;
/** The panel's own refresh, timed so its cost shows beside everything else's. */
const PANEL_SECTION = "profiler/panel";

function ms(value: number): string {
  return value >= 10 ? value.toFixed(1) : value >= 1 ? value.toFixed(2) : value.toFixed(3);
}

function percent(share: number): string {
  return `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;
}

function el<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

const GPU_STATUS: Record<GpuTimingStatus | "off", string> = {
  unsupported: "GPU time: not available; this renderer cannot time GPU work, which needs WebGPU with timestamp queries",
  waiting: "GPU time: waiting for the first reading",
  measuring: "GPU time: measured per render pass, arriving a few frames late; copies and mipmaps are not included",
  off: "GPU time: available once measuring",
};

/**
 * The frame budget: its profiling controls, streamgraphs of CPU, GPU, GPU
 * memory, memory and network by owner over the last minute, then where each
 * frame's time goes, section by section, with the frame interval's mean and
 * percentiles. It is the one home of the `renderer.profiling.*` parameters,
 * so a host shows it once and draws those parameters nowhere else. CPU rows
 * are the page's JavaScript; GPU and background rows run alongside the frame
 * and are never added to it. A measurement not available says so rather
 * than 0.
 */
export function createFrameBudgetPanel(options: FrameBudgetPanelOptions): FrameBudgetPanelHandle {
  const settings = options.settings;
  const { document, createParameterControl, createIconButton } = options.ui;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => el(document, tag, className, text);
  let destroyed = false;
  const { session } = options;
  const element = make("div", `foss-earth-frame-budget-panel${options.className ? ` ${options.className}` : ""}`);
  const controlsRow = make("div", "foss-earth-choices");
  if (options.title) controlsRow.append(make("div", "foss-earth-choices__heading foss-earth-choices__heading--inline", options.title));
  const controls = new Map<string, FrameBudgetControl>();
  for (const id of Object.values(FRAME_PROFILING_IDS)) {
    const control = createParameterControl(settings, id);
    controls.set(id, control);
    controlsRow.append(control.element);
  }
  // A value set elsewhere, such as a URL switch or a script, shows here too.
  const offControls = settings.subscribe(changed => {
    for (const id of changed) controls.get(id)?.update();
  });
  const status = make("p", "foss-earth-choices__note foss-earth-frame-budget__status");
  const overview = make("p", "foss-earth-choices__note");
  const table = make("table", "foss-earth-frame-budget");
  table.setAttribute("aria-label", "Frame budget");
  const head = make("thead");
  const headRow = make("tr");
  for (const label of ["Section", "Mean ms", "p95 ms", "p99 ms", "Max ms", "Of frame"]) headRow.append(make("th", undefined, label));
  head.append(headRow);
  const body = make("tbody");
  table.append(head, body);
  const readings = make("p", "foss-earth-choices__note");
  const notes = make("div", "foss-earth-choices");
  for (const text of options.notes ?? []) notes.append(make("p", "foss-earth-choices__note", text));
  const actions = make("div", "foss-earth-choices");
  const copy = createIconButton({ icon: "copy", label: "Copy frame budget" });
  const save = createIconButton({ icon: "download", label: "Save trace" });
  actions.append(copy, save);
  const results = make("div", "foss-earth-frame-budget__results");
  // A narrow panel scrolls the table, not the page.
  const scroller = make("div", "foss-earth-frame-budget__scroll");
  scroller.append(table);
  const streamsView = createResourceStreamsView({ document, streams: session.streams, seconds: () => session.streams.seconds });
  results.append(streamsView.element, overview, scroller, readings, notes, actions);
  element.append(controlsRow, status, results);

  const row = (section: FrameSectionStats, indent: number): HTMLTableRowElement => {
    const tr = make("tr");
    const name = make("th", undefined, section.name);
    name.scope = "row";
    name.style.paddingLeft = `${indent}px`;
    tr.append(name);
    for (const value of [section.meanMs, section.p95Ms, section.p99Ms, section.maxMs]) tr.append(make("td", undefined, ms(value)));
    tr.append(make("td", undefined, percent(section.shareOfFrame)));
    return tr;
  };
  const groupRow = (label: string): HTMLTableRowElement => {
    const tr = make("tr", "foss-earth-frame-budget__group");
    const th = make("th", undefined, label);
    th.scope = "row";
    th.colSpan = 6;
    tr.append(th);
    return tr;
  };
  const describe = (summary: FrameProfileSummary): string => {
    const unmeasured = Math.max(0, summary.frame.meanMs - summary.measuredMeanMs);
    const fps = summary.frame.meanMs > 0 ? `${(1000 / summary.frame.meanMs).toFixed(0)} fps` : "no rate yet";
    return `Last ${summary.frames} frames: ${ms(summary.frame.meanMs)} ms apart on average (${fps}), `
      + `p95 ${ms(summary.frame.p95Ms)} ms, p99 ${ms(summary.frame.p99Ms)} ms, longest ${ms(summary.frame.maxMs)} ms. `
      + `Measured work ${ms(summary.measuredMeanMs)} ms; the other ${ms(unmeasured)} ms is `
      + `${options.unmeasured ?? "work nobody has timed, the browser's own, and waiting for the display"}.`;
  };

  const refresh = (): void => {
    if (destroyed) return;
    const started = session.profiler.clock();
    try { summarise(); } finally { if (session.enabled) session.profiler.add(PANEL_SECTION, started); }
  };
  const summarise = (): void => {
    const enabled = session.enabled;
    if (enabled) {
      // While the globe is still, no frame closes the streams' sample, so the panel does.
      session.streams.update(session.profiler.clock());
      const shape = settings.get(FRAME_PROFILING_IDS.streamShape);
      streamsView.update(shape === "stacked" ? "stacked" : "stream");
    }
    const summary = enabled ? session.profiler.summary() : null;
    const trace = session.trace();
    const traceText = trace.capacity > 0
      ? `trace keeps ${trace.frames.length} of ${trace.capacity} frames (${(trace.bytes / BYTES_PER_KIB).toFixed(0)} KiB)`
      : "no trace kept";
    status.textContent = enabled
      ? `Collected ${summary!.frames} of ${session.profiler.windowFrames} frames; ${traceText}. ${GPU_STATUS[session.gpuStatus()]}.`
      : `Not measuring. ${GPU_STATUS[session.gpuTimed() ? "off" : "unsupported"]}.`;
    const problem = enabled ? session.streams.problem() : null;
    if (problem) status.textContent += ` A streamgraph's source failed: ${problem}`;
    save.hidden = trace.frames.length === 0;
    results.hidden = !summary || summary.frames === 0;
    if (!summary || summary.frames === 0) {
      if (enabled) status.textContent += " Collecting frames…";
      return;
    }
    overview.textContent = describe(summary);
    const cpu = summary.sections.filter(section => !section.section.startsWith("gpu") && !section.section.startsWith("background"));
    const gpu = summary.sections.filter(section => section.section.startsWith("gpu/"));
    const background = summary.sections.filter(section => section.section.startsWith("background/"));
    const rows: HTMLTableRowElement[] = cpu.map(section => row(section, section.depth * INDENT_PX + EDGE_PX));
    if (gpu.length > 0) rows.push(groupRow("GPU, alongside the frame"), ...gpu.map(section => row(section, INDENT_PX + EDGE_PX)));
    if (background.length > 0) rows.push(groupRow("Off the main thread, alongside the frame"), ...background.map(section => row(section, INDENT_PX + EDGE_PX)));
    body.replaceChildren(...rows);
    const lines = (options.readings ?? [])
      .map(id => [settings.spec(id)?.label, settings.getReading(id)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1]))
      .map(([label, value]) => `${label}: ${value}`);
    readings.textContent = lines.join(" · ");
    readings.hidden = lines.length === 0;
  };

  const invoke = (action: () => void | Promise<void>): void => {
    try { void Promise.resolve(action()).catch(error => options.actions.onError?.(error)); }
    catch (error) { options.actions.onError?.(error); }
  };
  const onCopy = (): void => invoke(() => options.actions.copy(JSON.stringify(session.profiler.summary(), null, 2)));
  const onSave = (): void => invoke(() => options.actions.saveJson(`${options.traceFileName ?? "frame-trace"}.json`, JSON.stringify(session.trace(), null, 1)));
  copy.addEventListener("click", onCopy);
  save.addEventListener("click", onSave);

  // Preserve the table's named period while using only the host's refresh subscription.
  let lastRefreshAt = options.refreshPort.nowMs();
  const schedule = (): void => { lastRefreshAt = options.refreshPort.nowMs(); refresh(); };
  schedule();
  const offSession = session.onChange(schedule);
  const offRefresh = settings.watch(FRAME_PROFILING_IDS.refreshMs, schedule);
  const offShape = settings.watch(FRAME_PROFILING_IDS.streamShape, schedule);
  const offHostRefresh = options.refreshPort.subscribe(() => {
    if (!session.enabled || !(options.isVisible?.() ?? (element.isConnected && element.closest("details")?.open !== false))) return;
    const at = options.refreshPort.nowMs();
    const period = settings.get(FRAME_PROFILING_IDS.refreshMs);
    if (at - lastRefreshAt < (typeof period === "number" ? period : 0)) return;
    lastRefreshAt = at;
    refresh();
  });

  return {
    element,
    refresh,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offHostRefresh();
      offSession();
      offRefresh();
      offShape();
      offControls();
      copy.removeEventListener("click", onCopy);
      save.removeEventListener("click", onSave);
      streamsView.destroy();
      for (const control of controls.values()) control.destroy();
      element.remove();
    },
  };
}
