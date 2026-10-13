import { RESOURCE_KINDS, type ResourceKind, type ResourceStream, type ResourceStreams, type ResourceUnit } from "../profiling/resourceStreams.js";

/**
 * "stream" centres the layers on a level line, as ThemeRiver does, so each
 * layer's own rise and fall shows on both sides of it; "stacked" starts them
 * from zero, so the total's does. Byron and Wattenberg's wiggle baseline
 * drifts over a scrolling window and draws trends that are not there, so it
 * is not used.
 */
export type StreamShape = "stream" | "stacked";

export interface StreamLayout {
  /** Layer indices in drawing order, lowest first. */
  order: number[];
  /** For each drawn layer, in `order`, its lower and upper edge at each sample. */
  lower: Float64Array[];
  upper: Float64Array[];
  /** The lowest lower edge and highest upper edge. */
  min: number;
  max: number;
}

/**
 * Where each layer's band lies. Stream puts the largest layers in the middle
 * and the smaller ones outside them, alternately above and below; stacked
 * puts the largest at the bottom. Both orders depend only on the totals, so
 * the bands keep their places as the graph scrolls.
 */
export function layoutStreams(values: readonly Float64Array[], shape: StreamShape): StreamLayout {
  const count = values.length;
  const samples = count ? values[0].length : 0;
  const totals = values.map(series => { let sum = 0; for (const value of series) sum += value; return sum; });
  const bySize = [...totals.keys()].sort((left, right) => totals[right] - totals[left] || left - right);
  let order = bySize;
  if (shape === "stream") {
    const above: number[] = [], below: number[] = [];
    let aboveSum = 0, belowSum = 0;
    for (const index of bySize) {
      if (aboveSum < belowSum) { above.push(index); aboveSum += totals[index]; }
      else { below.push(index); belowSum += totals[index]; }
    }
    order = below.reverse().concat(above);
  }
  const baseline = new Float64Array(samples);
  if (shape === "stream") {
    for (let sample = 0; sample < samples; sample++) {
      let total = 0;
      for (const series of values) total += series[sample];
      baseline[sample] = -total / 2;
    }
  }
  const lower: Float64Array[] = [], upper: Float64Array[] = [];
  const running = Float64Array.from(baseline);
  let min = Infinity, max = -Infinity;
  for (const index of order) {
    const low = Float64Array.from(running);
    for (let sample = 0; sample < samples; sample++) running[sample] += values[index][sample];
    const high = Float64Array.from(running);
    lower.push(low);
    upper.push(high);
  }
  for (let sample = 0; sample < samples; sample++) {
    min = Math.min(min, baseline[sample]);
    max = Math.max(max, running[sample]);
  }
  if (!Number.isFinite(min)) { min = 0; max = 0; }
  return { order, lower, upper, min, max };
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

function figure(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

export function formatBytes(bytes: number): string {
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit++; }
  return `${unit === 0 ? value.toFixed(0) : figure(value)} ${BYTE_UNITS[unit]}`;
}

export function formatAmount(value: number, unit: ResourceUnit): string {
  if (unit === "ms/s") return `${figure(value)} ms/s`;
  if (unit === "B/s") return `${formatBytes(value)}/s`;
  return formatBytes(value);
}

const TITLES: Record<ResourceKind, { title: string; describe: string }> = {
  cpu: { title: "CPU", describe: "Main-thread work per second, by section; 1000 ms/s keeps a whole thread busy." },
  gpu: { title: "GPU", describe: "GPU work per second, by pass." },
  vram: { title: "GPU memory", describe: "What each owner holds on the GPU." },
  ram: { title: "Memory", describe: "What each owner holds in main memory." },
  network: { title: "Network", describe: "Bytes received per second, by owner." },
};

/** Owners that stand for leftovers rather than anyone in particular are drawn grey. */
const NEUTRAL = /^(other|unnamed|unattributed|profiler)\b|\/other$/;
const LEGEND_ROWS = 8;
const CHART_HEIGHT_PX = 60;

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

interface LegendRow {
  item: HTMLLIElement;
  swatch: HTMLSpanElement;
  owner: HTMLSpanElement;
  value: HTMLSpanElement;
}

interface Chart {
  kind: ResourceKind;
  root: HTMLElement;
  caption: HTMLElement;
  canvas: HTMLCanvasElement;
  legend: HTMLElement;
  rows: LegendRow[];
  more: HTMLLIElement;
  note: HTMLElement;
  stream: ResourceStream | null;
  hover: number | null;
  /** The canvas's CSS width, read before anything is written so no layout is forced. */
  width: number;
}

/** Writes only what changed, so a refresh showing the same figures restyles nothing. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

export interface ResourceStreamsView {
  element: HTMLElement;
  /** Draws the streams' latest history. */
  update(shape: StreamShape): void;
  destroy(): void;
}

/**
 * Five streamgraphs, one per resource, each with its legend as the text
 * alternative: the owners and their figures now, or at the moment under the
 * pointer. An owner keeps its colour in every graph, and the parts of one
 * owner, such as "map/google tiles" and "map/raster tiles", share its hue.
 */
export function createResourceStreamsView(options: { document: Document; streams: ResourceStreams; seconds(): number }): ResourceStreamsView {
  const { document, streams } = options;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const element = make("div", "foss-earth-streams");
  const hues = new Map<string, number>();
  let shape: StreamShape = "stream";
  const colourOf = (owner: string): string => {
    const slash = owner.indexOf("/");
    const top = slash < 0 ? owner : owner.slice(0, slash);
    const part = slash < 0 ? "" : owner.slice(slash + 1);
    const shade = part ? 38 + (hash(part) % 4) * 9 : 50;
    if (NEUTRAL.test(owner)) return `hsl(215 10% ${shade + 8}%)`;
    let hue = hues.get(top);
    if (hue === undefined) {
      hue = (205 + hues.size * 137.508) % 360;
      hues.set(top, hue);
    }
    return `hsl(${hue.toFixed(0)} 62% ${shade}%)`;
  };

  const charts: Chart[] = RESOURCE_KINDS.map(kind => {
    const root = make("figure", "foss-earth-streams__chart");
    root.dataset.resource = kind;
    const caption = make("figcaption", "foss-earth-streams__caption", TITLES[kind].title);
    const canvas = make("canvas", "foss-earth-streams__canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.title = TITLES[kind].describe;
    const legend = make("ul", "foss-earth-streams__legend");
    legend.setAttribute("aria-label", `${TITLES[kind].title} by owner`);
    const rows = Array.from({ length: LEGEND_ROWS }, (): LegendRow => {
      const item = make("li");
      const swatch = make("span", "foss-earth-streams__swatch");
      const owner = make("span", "foss-earth-streams__owner");
      const value = make("span", "foss-earth-streams__value");
      item.append(swatch, owner, value);
      item.hidden = true;
      return { item, swatch, owner, value };
    });
    const more = make("li", "foss-earth-streams__more");
    more.hidden = true;
    legend.append(...rows.map(row => row.item), more);
    const note = make("p", "foss-earth-choices__note foss-earth-streams__note");
    note.hidden = true;
    root.append(caption, canvas, legend, note);
    element.append(root);
    return { kind, root, caption, canvas, legend, rows, more, note, stream: null, hover: null, width: 300 };
  });

  const span = (stream: ResourceStream): { from: number; to: number } => {
    const to = stream.ends[stream.ends.length - 1];
    return { from: to - options.seconds() * 1000, to };
  };

  const describeAt = (chart: Chart): void => {
    const stream = chart.stream;
    const { title } = TITLES[chart.kind];
    if (!stream) return;
    const last = stream.ends.length - 1;
    const at = chart.hover ?? last;
    // Every owner the graph shows stays in its legend, at zero too, so each band keeps its key.
    const rows = stream.layers.map(layer => {
      let total = 0;
      for (const value of layer.values) total += value;
      return { owner: layer.owner, value: at >= 0 ? layer.values[at] : 0, total };
    }).filter(row => row.total > 0)
      .sort((left, right) => right.value - left.value || right.total - left.total);
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const when = chart.hover === null ? "now" : `${((stream.ends[last] - stream.ends[at]) / 1000).toFixed(1)} s ago`;
    let text = `${title}: `;
    if (stream.unavailable && !rows.length) text += "not available";
    else if (at < 0) text += "collecting…";
    else {
      text += `${formatAmount(total, stream.unit)} ${when}`;
      if (chart.kind === "cpu" && stream.lengths[at] > 0) text += `, ${(stream.frames[at] * 1000 / stream.lengths[at]).toFixed(0)} frames/s`;
    }
    setText(chart.caption, text);
    chart.rows.forEach((legendRow, index) => {
      const row = rows[index];
      if (legendRow.item.hidden !== !row) legendRow.item.hidden = !row;
      if (!row) return;
      if (legendRow.owner.textContent !== row.owner) {
        legendRow.swatch.style.background = colourOf(row.owner);
        legendRow.owner.textContent = row.owner;
        legendRow.owner.title = row.owner;
      }
      setText(legendRow.value, formatAmount(row.value, stream.unit));
    });
    const hiddenRows = rows.length - LEGEND_ROWS;
    if (chart.more.hidden !== hiddenRows <= 0) chart.more.hidden = hiddenRows <= 0;
    if (hiddenRows > 0) setText(chart.more, `${hiddenRows} more`);
    const notes = [...(stream.unavailable ? [stream.unavailable] : []), ...stream.notes].join(" ");
    setText(chart.note, notes);
    if (chart.note.hidden !== !notes) chart.note.hidden = !notes;
  };

  const draw = (chart: Chart): void => {
    const stream = chart.stream;
    const canvas = chart.canvas;
    const view = document.defaultView;
    const ratio = view?.devicePixelRatio ?? 1;
    const width = chart.width;
    const height = CHART_HEIGHT_PX;
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    if (!stream || stream.ends.length === 0 || !stream.layers.length) return;
    const layout = layoutStreams(stream.layers.map(layer => layer.values), shape);
    const { from, to } = span(stream);
    const x = (time: number): number => (time - from) / Math.max(1, to - from) * width;
    const range = layout.max - layout.min;
    const pad = 2;
    const y = (value: number): number => range > 0 ? height - pad - (value - layout.min) / range * (height - 2 * pad) : height / 2;
    const times = stream.ends;
    const first = Math.max(0, times.findIndex(time => time >= from) - 1);
    layout.order.forEach((index, drawn) => {
      const lower = layout.lower[drawn], upper = layout.upper[drawn];
      context.beginPath();
      if (times.length === 1) {
        const start = x(times[0] - stream.lengths[0]), end = x(times[0]);
        context.moveTo(start, y(upper[0])); context.lineTo(end, y(upper[0]));
        context.lineTo(end, y(lower[0])); context.lineTo(start, y(lower[0]));
      } else {
        context.moveTo(x(times[first]), y(upper[first]));
        for (let sample = first + 1; sample < times.length; sample++) context.lineTo(x(times[sample]), y(upper[sample]));
        for (let sample = times.length - 1; sample >= first; sample--) context.lineTo(x(times[sample]), y(lower[sample]));
      }
      context.closePath();
      context.fillStyle = colourOf(stream.layers[index].owner);
      context.fill();
    });
    if (chart.hover !== null) {
      const at = x(times[chart.hover]);
      context.fillStyle = "rgba(127, 127, 127, 0.9)";
      context.fillRect(Math.round(at) - 0.5, 0, 1, height);
    }
  };

  const nearest = (chart: Chart, clientX: number): number | null => {
    const stream = chart.stream;
    if (!stream || !stream.ends.length) return null;
    const box = chart.canvas.getBoundingClientRect();
    const { from, to } = span(stream);
    const time = from + (clientX - box.left) / Math.max(1, box.width) * (to - from);
    let best = 0;
    for (let index = 1; index < stream.ends.length; index++) {
      if (Math.abs(stream.ends[index] - time) < Math.abs(stream.ends[best] - time)) best = index;
    }
    return best;
  };

  const listeners: Array<() => void> = [];
  for (const chart of charts) {
    const onMove = (event: PointerEvent): void => {
      chart.hover = nearest(chart, event.clientX);
      describeAt(chart);
      draw(chart);
    };
    const onLeave = (): void => {
      chart.hover = null;
      describeAt(chart);
      draw(chart);
    };
    chart.canvas.addEventListener("pointermove", onMove);
    chart.canvas.addEventListener("pointerleave", onLeave);
    listeners.push(() => {
      chart.canvas.removeEventListener("pointermove", onMove);
      chart.canvas.removeEventListener("pointerleave", onLeave);
    });
  }

  return {
    element,
    update(next) {
      shape = next;
      for (const chart of charts) chart.width = Math.max(1, chart.canvas.clientWidth || 300);
      for (const chart of charts) {
        chart.stream = streams.stream(chart.kind);
        if (chart.hover !== null && chart.hover >= chart.stream.ends.length) chart.hover = null;
        describeAt(chart);
        draw(chart);
      }
    },
    destroy() {
      for (const stop of listeners.splice(0)) stop();
      element.remove();
    },
  };
}
