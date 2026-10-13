// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameProfiler } from "../src/profiling/frameProfiler.js";
import { createResourceStreams, type ResourceSink } from "../src/profiling/resourceStreams.js";
import { createResourceStreamsView, formatAmount, formatBytes, layoutStreams } from "../src/panel/resourceStreamsView.js";

beforeEach(() => {
  // jsdom has no 2D canvas; the view draws nothing then and keeps its legends.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("stream layout", () => {
  const series = (...values: number[][]) => values.map(value => Float64Array.from(value));

  it("stacks from zero with the largest layer at the bottom", () => {
    const layout = layoutStreams(series([1, 1], [3, 3]), "stacked");
    expect(layout.order).toEqual([1, 0]);
    expect([...layout.lower[0]]).toEqual([0, 0]);
    expect([...layout.upper[0]]).toEqual([3, 3]);
    expect([...layout.upper[1]]).toEqual([4, 4]);
    expect([layout.min, layout.max]).toEqual([0, 4]);
  });

  it("centres the layers on the level line, the largest beside it, others alternately outside", () => {
    const layout = layoutStreams(series([1, 1], [3, 3], [2, 2]), "stream");
    expect(layout.order).toEqual([1, 2, 0]);
    expect([...layout.lower[0]]).toEqual([-3, -3]);
    expect([...layout.upper[0]]).toEqual([0, 0]);
    expect([...layout.upper[2]]).toEqual([3, 3]);
    expect([layout.min, layout.max]).toEqual([-3, 3]);
  });

  it("keeps the order fixed by totals as values move, so bands keep their places", () => {
    const early = layoutStreams(series([5, 0], [1, 1]), "stream").order;
    const late = layoutStreams(series([5, 0], [1, 9]), "stream").order;
    expect(early).toEqual([0, 1]);
    expect(late).toEqual([1, 0]);
    expect(layoutStreams([], "stream")).toMatchObject({ order: [], min: 0, max: 0 });
  });

  it("writes amounts in their units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.50 KiB");
    expect(formatBytes(324 * 1024 * 1024)).toBe("324 MiB");
    expect(formatAmount(412.4, "ms/s")).toBe("412 ms/s");
    expect(formatAmount(2.5 * 1024 * 1024, "B/s")).toBe("2.50 MiB/s");
  });
});

describe("resource streams view", () => {
  function setup(owners = 2) {
    let time = 0;
    const profiler = createFrameProfiler({ now: () => time, enabled: true });
    const streams = createResourceStreams({ profiler, sampleMs: 100 });
    streams.register({ kinds: ["ram"], sample(sink: ResourceSink) {
      for (let owner = 0; owner < owners; owner++) sink.add("ram", `owner ${owner}`, (owner + 1) * 1024);
    } });
    streams.setEnabled(true);
    profiler.frame(0);
    streams.update(0);
    const frames = (count: number) => {
      for (let frame = 0; frame < count; frame++) {
        const started = profiler.clock();
        time += 5;
        profiler.add("map/raster tiles", started);
        time += 20;
        profiler.frame(time);
        streams.update(time);
      }
    };
    const view = createResourceStreamsView({ document, streams, seconds: () => streams.seconds });
    document.body.append(view.element);
    const chart = (kind: string) => view.element.querySelector<HTMLElement>(`[data-resource="${kind}"]`)!;
    const legend = (kind: string) => [...chart(kind).querySelectorAll<HTMLElement>("li:not([hidden])")].map(item => item.textContent);
    return { streams, view, frames, chart, legend };
  }

  it("draws a figure per resource with its legend, and says what nothing measures", () => {
    const { view, frames, chart, legend } = setup();
    frames(8);
    view.update("stream");
    expect([...view.element.querySelectorAll("figure")].map(figure => figure.dataset.resource)).toEqual(["cpu", "gpu", "vram", "ram", "network"]);
    expect(chart("cpu").querySelector("figcaption")!.textContent).toBe("CPU: 200 ms/s now, 40 frames/s");
    expect(legend("cpu")).toEqual(["map/raster tiles200 ms/s"]);
    expect(legend("ram")).toEqual(["owner 12.00 KiB", "owner 01.00 KiB"]);
    const vram = chart("vram");
    expect(vram.querySelector("figcaption")!.textContent).toBe("GPU memory: not available");
    expect(vram.querySelector<HTMLElement>(".foss-earth-streams__note")!.hidden).toBe(false);
    expect(vram.querySelector(".foss-earth-streams__note")!.textContent).toBe("Nothing in this app measures it.");
    expect(chart("cpu").querySelector("canvas")!.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps an owner in the legend at zero while its band is in view, and counts the owners it has no room for", () => {
    const { view, frames, legend, streams } = setup(11);
    frames(4);
    streams.update(1000);
    view.update("stacked");
    expect(legend("cpu")).toEqual(["map/raster tiles0.00 ms/s"]);
    const rows = legend("ram");
    expect(rows).toHaveLength(9);
    expect(rows[0]).toBe("owner 1011.0 KiB");
    expect(rows[8]).toBe("3 more");
  });

  it("describes the moment under the pointer, then the present again", () => {
    const { view, frames, chart } = setup();
    frames(12);
    view.update("stream");
    const canvas = chart("ram").querySelector("canvas")!;
    canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 0 }));
    expect(chart("ram").querySelector("figcaption")!.textContent).toMatch(/^Memory: 3\.00 KiB [\d.]+ s ago$/);
    canvas.dispatchEvent(new MouseEvent("pointerleave"));
    expect(chart("ram").querySelector("figcaption")!.textContent).toBe("Memory: 3.00 KiB now");
  });

  it("leaves the page and its pointer listeners on destroy", () => {
    const { view, frames, chart } = setup();
    frames(4);
    view.update("stream");
    const canvas = chart("ram").querySelector("canvas")!;
    const caption = chart("ram").querySelector("figcaption")!;
    view.destroy();
    expect(view.element.isConnected).toBe(false);
    canvas.dispatchEvent(new MouseEvent("pointermove", { clientX: 0 }));
    expect(caption.textContent).toBe("Memory: 3.00 KiB now");
  });
});
