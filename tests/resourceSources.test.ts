import { describe, expect, it, vi } from "vitest";
import { createMemorySource, HEAP_REST } from "../src/profiling/memorySource.js";
import { createNetworkSource, type ResourceTimingEntry } from "../src/profiling/networkSource.js";
import type { ResourceSink, ResourceSource } from "../src/profiling/resourceStreams.js";

function sampled(source: ResourceSource) {
  const added: Record<string, number> = {};
  const notes: string[] = [];
  const sink: ResourceSink = {
    add: (_kind, owner, amount) => { added[owner] = (added[owner] ?? 0) + amount; },
    unavailable: () => undefined,
    note: (_kind, text) => notes.push(text),
  };
  source.sample(sink, { start: 0, end: 250 });
  return { added, notes };
}

const entry = (name: string, sizes: Partial<ResourceTimingEntry> = {}): ResourceTimingEntry => ({
  name, initiatorType: "fetch", transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, responseStart: 10, ...sizes,
});

describe("network source", () => {
  function setup() {
    let deliver: ((entries: readonly ResourceTimingEntry[]) => void) | null = null;
    const detach = vi.fn(() => { deliver = null; });
    const observe = vi.fn((listener: (entries: readonly ResourceTimingEntry[]) => void) => { deliver = listener; return detach; });
    const source = createNetworkSource({
      observe,
      owner: url => url.includes("tiles") ? "map/terrain" : url.includes("app") ? "app files" : null,
      metered: ["map/terrain"],
    });
    return { source, observe, detach, deliver: (entries: readonly ResourceTimingEntry[]) => deliver?.(entries) };
  }

  it("observes only while measuring", () => {
    const { source, observe, detach } = setup();
    expect(source.measuring).toBe(false);
    expect(observe).not.toHaveBeenCalled();
    source.start?.();
    expect(source.measuring).toBe(true);
    source.stop?.();
    expect(detach).toHaveBeenCalledOnce();
    expect(source.measuring).toBe(false);
  });

  it("adds received bytes by owner, once per sample, and nothing for a cached response", () => {
    const { source, deliver } = setup();
    source.start?.();
    deliver([entry("https://example.test/app/main.js", { transferSize: 300 }), entry("https://example.test/app/style.css", { transferSize: 100 }),
      entry("https://elsewhere.test/x.json", { transferSize: 50 }), entry("https://example.test/app/cached.js", { encodedBodySize: 900, decodedBodySize: 900 })]);
    expect(sampled(source)).toEqual({ added: { "app files": 400, other: 50 }, notes: [] });
    expect(sampled(source).added).toEqual({});
  });

  it("counts a metered owner only from the host, and only while measuring", () => {
    const { source, deliver } = setup();
    source.received("map/terrain", 999);
    source.start?.();
    deliver([entry("https://tiles.test/1.png", { transferSize: 5000 })]);
    source.received("map/terrain", 700);
    source.received("map/terrain", Number.NaN);
    expect(sampled(source).added).toEqual({ "map/terrain": 700 });
  });

  it("names requests whose size is hidden rather than guessing them", () => {
    const { source, deliver } = setup();
    source.start?.();
    const hidden = { responseStart: 0 };
    deliver([entry("https://elsewhere.test/a", hidden), entry("https://elsewhere.test/b", hidden), entry("https://example.test/app/c", hidden)]);
    const { added, notes } = sampled(source);
    expect(added).toEqual({});
    expect(notes).toEqual(["Requests whose server hides their size, left out: 2 to other, 1 to app files."]);
    source.stop?.(); source.start?.();
    expect(sampled(source).notes).toEqual([]);
  });
});

describe("memory source", () => {
  it("adds each owner, and the heap's rest without the owners counted in it", () => {
    const source = createMemorySource({ heapBytes: () => 1000 });
    source.track("images/encoded", () => 300, { inHeap: true });
    source.track("images/decoded", () => 500);
    expect(sampled(source).added).toEqual({ "images/encoded": 300, "images/decoded": 500, [HEAP_REST]: 700 });
  });

  it("skips owners that hold nothing or fail, and stops reading a removed one", () => {
    const source = createMemorySource({ heapBytes: () => 100 });
    const removed = vi.fn(() => 10);
    source.track("empty", () => 0);
    source.track("unknown", () => null);
    source.track("broken", () => { throw new Error("gone"); });
    source.track("removed", removed)();
    expect(sampled(source).added).toEqual({ [HEAP_REST]: 100 });
    expect(removed).not.toHaveBeenCalled();
  });

  it("never draws the heap's rest below zero, and says when the browser reports no heap", () => {
    const counted = createMemorySource({ heapBytes: () => 100 });
    counted.track("typed arrays", () => 400, { inHeap: true });
    expect(sampled(counted).added[HEAP_REST]).toBe(0);
    const unreported = createMemorySource({ heapBytes: () => null });
    unreported.track("images", () => 5);
    const { added, notes } = sampled(unreported);
    expect(added).toEqual({ images: 5 });
    expect(notes[0]).toMatch(/does not report its JavaScript heap/);
  });
});
