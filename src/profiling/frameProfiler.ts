
/**
 * Where a frame's time goes, by named section.
 *
 * Callers bracket their own work:
 *
 *     const started = profiler.clock();
 *     stepPhysics();
 *     profiler.add("flight/physics", started);
 *
 * and call `frame()` once per frame. The profiler keeps each section's total
 * per frame over a rolling window, and summarises it against the frame
 * interval. Disabled, every call returns at once, so instrumented code can
 * stay instrumented.
 *
 * Sections nest by path: "flight/physics" is part of "flight". Only top-level
 * sections are added up against the frame; nested ones break their parent
 * down. Time no section claims is reported as unmeasured: work nobody has
 * instrumented yet, the browser's own work, and idle time waiting for the
 * display. Concurrent sections, "gpu" and "background" by default, run
 * alongside the frame rather than in it and are never added to it: GPU work,
 * and work the browser does off the main thread, such as decoding an image.
 *
 * A trace, off by default, keeps each of the last `traceFrames` frames whole:
 * its interval, every section's time and any tags, such as the engine frame
 * the frame drew, for a script to line frames up with what they showed.
 */

const DEFAULT_WINDOW_FRAMES = 600;
/** What one retained trace frame costs: its three numbers and one per entry, name and value. */
const TRACE_FRAME_BYTES = 24;
const TRACE_ENTRY_BYTES = 16;

export interface FrameProfiler {
  /** Switchable at any time; turning it on starts a fresh window. */
  enabled: boolean;
  /** A timestamp to hand back to `add`; 0 while disabled. */
  clock(): number;
  /** Adds the time since `startedAt` to the section, for this frame. */
  add(section: string, startedAt: number): void;
  /** Adds a duration measured some other way, such as a GPU timer that reports frames late. */
  addDuration(section: string, milliseconds: number): void;
  /** The section's time so far this frame. */
  current(section: string): number;
  /** Labels this frame in the trace, such as `tag("engine frame", engine.frameId)`. */
  tag(key: string, value: number): void;
  /** Closes the frame begun at the previous call and starts the next. */
  frame(now?: number): void;
  summary(): FrameProfileSummary;
  /** The retained frames, oldest first; empty while `traceFrames` is 0. */
  trace(): FrameTrace;
  /** Frames the summary covers and frames the trace keeps. Changing either starts afresh. */
  readonly windowFrames: number;
  readonly traceFrames: number;
  configure(options: { windowFrames?: number; traceFrames?: number }): void;
  reset(): void;
}

export interface FrameTimeStats {
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface FrameTraceEntry {
  /** Frames closed before this one since the profiler last started afresh. */
  index: number;
  /** When the frame closed, on the profiler's clock. */
  endedAtMs: number;
  intervalMs: number;
  /** Every section that did work in the frame. */
  sections: Record<string, number>;
  tags: Record<string, number>;
}

export interface FrameTrace {
  /** Frames the trace can hold. */
  capacity: number;
  frames: FrameTraceEntry[];
  /** About what the retained frames take in memory. */
  bytes: number;
}

export interface FrameSectionStats extends FrameTimeStats {
  section: string;
  /** The last path segment, for display under its parent. */
  name: string;
  depth: number;
  /** Mean time as a share of the mean frame interval. */
  shareOfFrame: number;
  /** Frames the section did any work in, out of `frames`. */
  activeFrames: number;
}

export interface FrameProfileSummary {
  /** Frames in the window. */
  frames: number;
  /** Time between frames. */
  frame: FrameTimeStats;
  /** Mean of the top-level sections added up, concurrent ones left out. */
  measuredMeanMs: number;
  /** Parents before their children; siblings by mean time, largest first. */
  sections: FrameSectionStats[];
}

interface SectionTrack {
  values: Float64Array;
  current: number;
  /** Frames committed before this section first reported, which it has no values for. */
  bornAtFrame: number;
}

function percentile(sorted: Float64Array, rank: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * rank))];
}

function stats(values: Float64Array): FrameTimeStats {
  if (values.length === 0) return { meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  const sorted = Float64Array.from(values).sort();
  let total = 0;
  for (const value of sorted) total += value;
  return {
    meanMs: total / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1],
  };
}

export interface FrameProfilerOptions {
  /** Frames kept for the summary; 600 is ten seconds at 60 fps. */
  windowFrames?: number;
  /** Frames kept whole for `trace()`; 0, the default, keeps none. */
  traceFrames?: number;
  enabled?: boolean;
  /** Top-level sections that run alongside the frame, such as GPU work; "gpu" and "background" when omitted. */
  concurrent?: readonly string[];
  now: () => number;
}

export function createFrameProfiler(options: FrameProfilerOptions): FrameProfiler {
  let capacity = Math.max(1, Math.floor(options.windowFrames ?? DEFAULT_WINDOW_FRAMES));
  let traceCapacity = Math.max(0, Math.floor(options.traceFrames ?? 0));
  const now = options.now;
  const tracks = new Map<string, SectionTrack>();
  let intervals = new Float64Array(capacity);
  let committed = 0;
  let lastFrameAt: number | null = null;
  let enabled = options.enabled ?? false;
  const concurrent = new Set(options.concurrent ?? ["gpu", "background"]);
  let tags: Record<string, number> = {};
  let traced: FrameTraceEntry[] = [];
  let tracedBytes = 0;

  const track = (section: string): SectionTrack => {
    let found = tracks.get(section);
    if (!found) {
      found = { values: new Float64Array(capacity), current: 0, bornAtFrame: committed };
      tracks.set(section, found);
    }
    return found;
  };

  /** The window's values, oldest first, from the frame the track began. */
  const windowOf = (values: Float64Array, bornAtFrame: number): Float64Array => {
    const count = Math.min(committed - bornAtFrame, capacity);
    const out = new Float64Array(Math.max(0, count));
    for (let index = 0; index < out.length; index++) {
      out[index] = values[(committed - out.length + index) % capacity];
    }
    return out;
  };

  const reset = (): void => {
    tracks.clear();
    intervals = new Float64Array(capacity);
    committed = 0;
    lastFrameAt = null;
    tags = {};
    traced = [];
    tracedBytes = 0;
  };

  const entryBytes = (entry: FrameTraceEntry): number =>
    TRACE_FRAME_BYTES + TRACE_ENTRY_BYTES * (Object.keys(entry.sections).length + Object.keys(entry.tags).length);

  const keepTrace = (at: number, interval: number): void => {
    const sections: Record<string, number> = {};
    for (const [section, entry] of tracks) if (entry.current > 0) sections[section] = entry.current;
    const entry: FrameTraceEntry = { index: committed, endedAtMs: at, intervalMs: interval, sections, tags };
    traced.push(entry);
    tracedBytes += entryBytes(entry);
    while (traced.length > traceCapacity) tracedBytes -= entryBytes(traced.shift()!);
  };

  return {
    get enabled() {
      return enabled;
    },
    set enabled(next: boolean) {
      if (next === enabled) return;
      enabled = next;
      if (next) reset();
    },
    clock: () => (enabled ? now() : 0),
    add(section, startedAt) {
      if (!enabled) return;
      track(section).current += now() - startedAt;
    },
    addDuration(section, milliseconds) {
      if (!enabled || !Number.isFinite(milliseconds)) return;
      track(section).current += milliseconds;
    },
    current: section => tracks.get(section)?.current ?? 0,
    tag(key, value) {
      if (enabled && traceCapacity > 0) tags[key] = value;
    },
    frame(at = now()) {
      if (!enabled) return;
      if (lastFrameAt !== null) {
        const slot = committed % capacity;
        intervals[slot] = at - lastFrameAt;
        if (traceCapacity > 0) keepTrace(at, at - lastFrameAt);
        for (const entry of tracks.values()) {
          entry.values[slot] = entry.current;
          entry.current = 0;
        }
        committed++;
      } else {
        for (const entry of tracks.values()) entry.current = 0;
      }
      tags = {};
      lastFrameAt = at;
    },
    summary() {
      const frame = stats(windowOf(intervals, 0));
      const children = new Map<string, FrameSectionStats[]>();
      let measuredMeanMs = 0;
      for (const [section, entry] of tracks) {
        const values = windowOf(entry.values, entry.bornAtFrame);
        const slash = section.lastIndexOf("/");
        const parent = slash < 0 ? "" : section.slice(0, slash);
        const sectionStats = stats(values);
        // A section that began partway through the window still costs its share of every frame.
        const meanOverWindow = sectionStats.meanMs * values.length / Math.max(1, Math.min(committed, capacity));
        if (!parent && !concurrent.has(section)) measuredMeanMs += meanOverWindow;
        let activeFrames = 0;
        for (const value of values) if (value > 0) activeFrames++;
        const list = children.get(parent) ?? [];
        list.push({
          ...sectionStats,
          section,
          name: slash < 0 ? section : section.slice(slash + 1),
          depth: section.split("/").length - 1,
          shareOfFrame: frame.meanMs > 0 ? meanOverWindow / frame.meanMs : 0,
          activeFrames,
        });
        children.set(parent, list);
      }
      // A parent that never reports itself, such as "gpu", gets a row that adds its children up.
      for (const parent of [...children.keys()]) {
        if (!parent || tracks.has(parent)) continue;
        const summed = new Float64Array(Math.min(committed, capacity));
        for (const [section, entry] of tracks) {
          if (section.slice(0, section.lastIndexOf("/")) !== parent) continue;
          const values = windowOf(entry.values, entry.bornAtFrame);
          for (let index = 0; index < values.length; index++) summed[summed.length - values.length + index] += values[index];
        }
        const slash = parent.lastIndexOf("/");
        const grandparent = slash < 0 ? "" : parent.slice(0, slash);
        const parentStats = stats(summed);
        let activeFrames = 0;
        for (const value of summed) if (value > 0) activeFrames++;
        if (!grandparent && !concurrent.has(parent)) measuredMeanMs += parentStats.meanMs;
        const list = children.get(grandparent) ?? [];
        list.push({
          ...parentStats,
          section: parent,
          name: slash < 0 ? parent : parent.slice(slash + 1),
          depth: parent.split("/").length - 1,
          shareOfFrame: frame.meanMs > 0 ? parentStats.meanMs / frame.meanMs : 0,
          activeFrames,
        });
        children.set(grandparent, list);
      }
      const sections: FrameSectionStats[] = [];
      const visit = (parent: string): void => {
        for (const child of (children.get(parent) ?? []).sort((left, right) => right.meanMs - left.meanMs)) {
          sections.push(child);
          visit(child.section);
        }
      };
      visit("");
      return { frames: Math.min(committed, capacity), frame, measuredMeanMs, sections };
    },
    trace: () => ({ capacity: traceCapacity, frames: [...traced], bytes: tracedBytes }),
    get windowFrames() {
      return capacity;
    },
    get traceFrames() {
      return traceCapacity;
    },
    configure(next) {
      const windowFrames = Math.max(1, Math.floor(next.windowFrames ?? capacity));
      const traceFrames = Math.max(0, Math.floor(next.traceFrames ?? traceCapacity));
      if (windowFrames === capacity && traceFrames === traceCapacity) return;
      capacity = windowFrames;
      traceCapacity = traceFrames;
      reset();
    },
    reset,
  };
}

