import { describe, expect, it, vi } from "vitest";
import { createFrameProfiler } from "../src/profiling/frameProfiler.js";
import {
  createResourceStreams, sectionOwners, STREAMS_SECTION,
  type ResourceSink, type ResourceSource,
} from "../src/profiling/resourceStreams.js";

const values = (streams: ReturnType<typeof createResourceStreams>, kind: Parameters<typeof streams.stream>[0]) =>
  Object.fromEntries(streams.stream(kind).layers.map(layer => [layer.owner, [...layer.values]]));

describe("section owners", () => {
  it("splits parents into their children, keeps their untimed rest, and names GPU passes", () => {
    const owners = sectionOwners(new Map([
      ["render", 10], ["render/draw", 6], ["render/active meshes", 3],
      ["map/raster tiles", 4], ["map/google tiles", 1],
      ["sky", 2],
      ["gpu/globe", 5], ["gpu/panorama", 1],
    ]));
    expect(Object.fromEntries(owners.cpu)).toEqual({
      "render/draw": 6, "render/active meshes": 3, "render/other": 1,
      "map/raster tiles": 4, "map/google tiles": 1, sky: 2,
    });
    expect(Object.fromEntries(owners.gpu)).toEqual({ globe: 5, panorama: 1 });
  });

  it("adds a section without its own report up from its children, however deep", () => {
    const owners = sectionOwners(new Map([["map/tiles/decode", 2], ["map/tiles/upload", 3], ["map/camera", 1]]));
    expect(Object.fromEntries(owners.cpu)).toEqual({ "map/tiles": 5, "map/camera": 1 });
  });

  it("leaves out sections that took no time", () => {
    const owners = sectionOwners(new Map([["sky", 0], ["render", 0], ["render/draw", 0], ["gpu/globe", 0]]));
    expect(owners.cpu.size).toBe(0);
    expect(owners.gpu.size).toBe(0);
  });
});

describe("resource streams", () => {
  const source = (sample: (sink: ResourceSink) => void, kinds: ResourceSource["kinds"] = ["ram"]): ResourceSource => ({ kinds, sample });

  it("does nothing until measuring starts, and starts each history afresh", () => {
    const sample = vi.fn((sink: ResourceSink) => sink.add("ram", "heap", 1));
    const streams = createResourceStreams({ sampleMs: 100 });
    streams.register(source(sample));
    streams.update(0); streams.update(500);
    expect(sample).not.toHaveBeenCalled();
    expect(streams.stream("ram").ends.length).toBe(0);
    streams.setEnabled(true);
    streams.update(1000); streams.update(1100); streams.update(1200);
    expect([...streams.stream("ram").ends]).toEqual([1100, 1200]);
    streams.setEnabled(false); streams.setEnabled(true);
    expect(streams.stream("ram").ends.length).toBe(0);
  });

  it("closes a sample only once its length has passed, ignoring earlier times", () => {
    const streams = createResourceStreams({ sampleMs: 250 });
    streams.register(source(sink => sink.add("ram", "heap", 1)));
    streams.setEnabled(true);
    streams.update(1000); streams.update(1100); streams.update(900); streams.update(1249);
    expect(streams.stream("ram").ends.length).toBe(0);
    streams.update(1300);
    const stream = streams.stream("ram");
    expect([...stream.ends]).toEqual([1300]);
    expect([...stream.lengths]).toEqual([300]);
  });

  it("turns rates into amounts per second and keeps levels as they are", () => {
    const streams = createResourceStreams({ sampleMs: 500 });
    streams.register(source(sink => {
      sink.add("network", "map/terrain", 1000);
      sink.add("ram", "heap", 4096);
      sink.add("ram", "heap", 4096);
    }, ["network", "ram"]));
    streams.setEnabled(true);
    streams.update(0); streams.update(500);
    expect(values(streams, "network")).toEqual({ "map/terrain": [2000] });
    expect(values(streams, "ram")).toEqual({ heap: [8192] });
    expect(streams.stream("network").unit).toBe("B/s");
    expect(streams.stream("ram").unit).toBe("B");
  });

  it("fills CPU and GPU from the profiler's drained sections, with frames per sample, and counts its own cost", () => {
    let time = 0;
    const profiler = createFrameProfiler({ now: () => time, enabled: true });
    const streams = createResourceStreams({ profiler, sampleMs: 100 });
    streams.setEnabled(true);
    profiler.frame(0);
    streams.update(0);
    for (let frame = 0; frame < 4; frame++) {
      const started = profiler.clock();
      time += 5;
      profiler.add("map/raster tiles", started);
      profiler.addDuration("gpu/globe", 2);
      time += 20;
      profiler.frame(time);
    }
    streams.update(time);
    expect(values(streams, "cpu")).toEqual({ "map/raster tiles": [200] });
    expect(values(streams, "gpu")).toEqual({ globe: [80] });
    expect([...streams.stream("cpu").frames]).toEqual([4]);
    profiler.frame(time + 1);
    expect(profiler.summary().sections.map(section => section.section)).toContain(STREAMS_SECTION);
  });

  it("says CPU and GPU are unavailable without a profiler that drains, and names resources nothing measures", () => {
    const streams = createResourceStreams({ sampleMs: 100 });
    streams.register(source(sink => sink.add("ram", "heap", 1)));
    streams.setEnabled(true);
    streams.update(0); streams.update(100);
    expect(streams.stream("cpu").unavailable).toMatch(/no time series/);
    expect(streams.stream("vram").unavailable).toBe("Nothing in this app measures it.");
    expect(streams.stream("ram").unavailable).toBeNull();
    expect(streams.stream("network").unavailable).toBe("Nothing in this app measures it.");
  });

  it("keeps a measured resource at zero rather than unavailable when its source adds nothing", () => {
    const streams = createResourceStreams({ sampleMs: 100 });
    streams.register(source(() => undefined, ["network"]));
    streams.setEnabled(true);
    streams.update(0); streams.update(100);
    const stream = streams.stream("network");
    expect(stream.unavailable).toBeNull();
    expect(stream.ends.length).toBe(1);
  });

  it("passes a source's reasons and notes through, the newest sample's only", () => {
    let round = 0;
    const streams = createResourceStreams({ sampleMs: 100 });
    streams.register(source(sink => {
      round++;
      if (round === 1) { sink.unavailable("vram", "No GPU here."); sink.note("vram", "Estimated."); sink.note("vram", "Estimated."); }
    }, ["vram"]));
    streams.setEnabled(true);
    streams.update(0); streams.update(100);
    expect(streams.stream("vram").unavailable).toBe("No GPU here.");
    expect(streams.stream("vram").notes).toEqual(["Estimated."]);
    streams.update(200);
    expect(streams.stream("vram").unavailable).toBeNull();
    expect(streams.stream("vram").notes).toEqual([]);
  });

  it("gives new owners past the limit to \"other\", and an owner joining later zeros before it came", () => {
    let round = 0;
    const streams = createResourceStreams({ sampleMs: 100, ownerLimit: 2 });
    streams.register(source(sink => {
      round++;
      sink.add("ram", "a", 1);
      if (round >= 2) sink.add("ram", "b", 2);
      if (round >= 3) { sink.add("ram", "c", 4); sink.add("ram", "d", 8); }
    }));
    streams.setEnabled(true);
    streams.update(0); streams.update(100); streams.update(200); streams.update(300);
    expect(values(streams, "ram")).toEqual({ a: [1, 1, 1], b: [0, 2, 2], other: [0, 0, 12] });
  });

  it("keeps only the history asked for and forgets owners gone for all of it", () => {
    let round = 0;
    // A second of 250 ms samples keeps five, so the oldest still reaches the graph's left edge.
    const streams = createResourceStreams({ sampleMs: 250, seconds: 1 });
    streams.register(source(sink => {
      round++;
      sink.add("ram", "kept", round);
      if (round === 1) sink.add("ram", "gone", 5);
    }));
    streams.setEnabled(true);
    streams.update(0);
    for (let at = 250; at <= 1750; at += 250) streams.update(at);
    const stream = streams.stream("ram");
    expect([...stream.ends]).toEqual([750, 1000, 1250, 1500, 1750]);
    expect(values(streams, "ram")).toEqual({ kept: [3, 4, 5, 6, 7] });
  });

  it("starts and stops sources with measuring, registered before or during it", () => {
    const first = { start: vi.fn(), stop: vi.fn(), sample: vi.fn() };
    const second = { start: vi.fn(), stop: vi.fn(), sample: vi.fn() };
    const streams = createResourceStreams();
    streams.register(first);
    expect(first.start).not.toHaveBeenCalled();
    streams.setEnabled(true);
    expect(first.start).toHaveBeenCalledOnce();
    const unregister = streams.register(second);
    expect(second.start).toHaveBeenCalledOnce();
    unregister(); unregister();
    expect(second.stop).toHaveBeenCalledOnce();
    streams.setEnabled(false);
    expect(first.stop).toHaveBeenCalledOnce();
    streams.dispose();
    streams.setEnabled(true);
    expect(first.start).toHaveBeenCalledOnce();
  });

  it("keeps sampling when a source throws, and reports the failure until measuring restarts", () => {
    const streams = createResourceStreams({ sampleMs: 100 });
    streams.register({ kinds: ["vram"], sample() { throw new Error("walk failed"); } });
    streams.register(source(sink => sink.add("ram", "heap", 1)));
    streams.setEnabled(true);
    streams.update(0); streams.update(100);
    expect(streams.problem()).toBe("walk failed");
    expect(values(streams, "ram")).toEqual({ heap: [1] });
    streams.setEnabled(false); streams.setEnabled(true);
    expect(streams.problem()).toBeNull();
  });

  it("starts afresh when the sample length or history changes while measuring", () => {
    const streams = createResourceStreams({ sampleMs: 100 });
    streams.register(source(sink => sink.add("ram", "heap", 1)));
    streams.setEnabled(true);
    streams.update(0); streams.update(100);
    streams.configure({ sampleMs: 100 });
    expect(streams.stream("ram").ends.length).toBe(1);
    streams.configure({ seconds: 30 });
    expect(streams.seconds).toBe(30);
    expect(streams.stream("ram").ends.length).toBe(0);
  });
});
