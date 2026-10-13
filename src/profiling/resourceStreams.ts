import type { FrameProfiler } from "./frameProfiler.js";

/**
 * What the page spends, and on whom, over the last minute or so: CPU and GPU
 * time, GPU memory, main memory and bytes received, for the streamgraphs.
 *
 * A sample closes every `sampleMs`, at the frame boundary or when a shown
 * panel asks. The frame profiler's sections fill the CPU and GPU streams;
 * sources the host registers add memory and network, each naming the owner
 * of what it adds.
 *
 * Nothing is sampled, observed or kept while measuring is off: sources start
 * when it starts and stop when it stops, and each start begins a fresh
 * history. A resource a source cannot measure is reported unavailable, never
 * as zero.
 */

export type ResourceKind = "cpu" | "gpu" | "vram" | "ram" | "network";

export const RESOURCE_KINDS: readonly ResourceKind[] = ["cpu", "gpu", "vram", "ram", "network"];

/**
 * "ms/s": work per second of time, so 1000 is one thread kept busy. "B/s":
 * bytes received per second. "B": bytes held when the sample closed.
 */
export type ResourceUnit = "ms/s" | "B/s" | "B";

export const RESOURCE_UNITS: Readonly<Record<ResourceKind, ResourceUnit>> = {
  cpu: "ms/s",
  gpu: "ms/s",
  vram: "B",
  ram: "B",
  network: "B/s",
};

export interface ResourceSink {
  /**
   * Adds to an owner's share of the sample: ms of work for cpu and gpu, bytes
   * received for network, bytes held now for vram and ram.
   */
  add(kind: ResourceKind, owner: string, amount: number): void;
  /** Why the sample has no figure for this resource, such as a browser that cannot time the GPU. */
  unavailable(kind: ResourceKind, reason: string): void;
  /** A remark shown under the stream, such as requests whose size the browser hides. */
  note(kind: ResourceKind, text: string): void;
}

/** The span a sample covers, on the streams' clock. */
export interface ResourceSampleWindow {
  start: number;
  end: number;
}

export interface ResourceSource {
  /** The resources it measures: one no source measures is reported unavailable rather than zero. */
  readonly kinds?: readonly ResourceKind[];
  /** Begins observing, when measuring starts. */
  start?(): void;
  /** Adds what the source saw since the previous sample, or what is held now. */
  sample(sink: ResourceSink, window: ResourceSampleWindow): void;
  /** Stops observing and lets go of what it holds, when measuring stops. */
  stop?(): void;
}

export interface ResourceLayer {
  owner: string;
  /** One value per kept sample, oldest first, in the stream's unit. */
  values: Float64Array;
}

export interface ResourceStream {
  kind: ResourceKind;
  unit: ResourceUnit;
  /** When each kept sample closed, oldest first, on the streams' clock. */
  ends: Float64Array;
  /** How long each kept sample lasted, in ms. */
  lengths: Float64Array;
  /** Frames the profiler closed in each kept sample. */
  frames: Float64Array;
  /** Owners in the order they first appeared. */
  layers: ResourceLayer[];
  /** Why the newest sample has no figure, or null when it has one. */
  unavailable: string | null;
  /** The newest sample's remarks. */
  notes: readonly string[];
}

export interface ResourceStreams {
  readonly enabled: boolean;
  /** Starting begins a fresh history and starts the sources; stopping stops them. */
  setEnabled(enabled: boolean): void;
  readonly sampleMs: number;
  readonly seconds: number;
  /** Changes the sample length or the history kept; either change starts afresh. */
  configure(options: { sampleMs?: number; seconds?: number }): void;
  /** Adds a source, started at once while measuring. Returns a function that stops and removes it. */
  register(source: ResourceSource): () => void;
  /** Closes the sample once `sampleMs` has passed since it began; `now` is on the profiler's clock. */
  update(now: number): void;
  /** The kept history of one resource. */
  stream(kind: ResourceKind): ResourceStream;
  /** The latest failure of a source, until measuring starts again. */
  problem(): string | null;
  /** Stops the sources for good. */
  dispose(): void;
}

export interface ResourceStreamsOptions {
  /**
   * Its "gpu/*" sections fill the GPU stream and every other section the CPU
   * stream; the streams' own cost is added to it as "profiler/streams".
   */
  profiler?: FrameProfiler;
  /** ms per sample; 250 when omitted. */
  sampleMs?: number;
  /** Seconds of history kept; 60 when omitted. */
  seconds?: number;
  /** Owners kept apart per resource before the rest are added up as "other"; 16 when omitted. */
  ownerLimit?: number;
}

export const DEFAULT_STREAM_SAMPLE_MS = 250;
export const DEFAULT_STREAM_SECONDS = 60;
const DEFAULT_OWNER_LIMIT = 16;
const OTHER = "other";
export const STREAMS_SECTION = "profiler/streams";

interface Track {
  values: Float64Array;
  /** Samples committed before the owner was last seen. */
  lastSeen: number;
}

interface KindState {
  tracks: Map<string, Track>;
  pending: Map<string, number>;
  sampleUnavailable: string | null;
  sampleNotes: string[];
  unavailable: string | null;
  notes: string[];
}

const isRate = (kind: ResourceKind): boolean => RESOURCE_UNITS[kind] !== "B";

/**
 * Adds a drain's sections up into owners: a section that reports itself
 * stands for its children, and one that does not is the sum of them.
 */
export function sectionOwners(sections: ReadonlyMap<string, number>): { cpu: Map<string, number>; gpu: Map<string, number> } {
  const cpu = new Map<string, number>();
  const gpu = new Map<string, number>();
  const childrenOf = (path: string): string[] => {
    const prefix = path ? `${path}/` : "";
    const children = new Set<string>();
    for (const section of sections.keys()) {
      if (!section.startsWith(prefix)) continue;
      const rest = section.slice(prefix.length);
      const slash = rest.indexOf("/");
      children.add(prefix + (slash < 0 ? rest : rest.slice(0, slash)));
    }
    return [...children];
  };
  const total = (path: string): number => {
    const own = sections.get(path);
    if (own !== undefined) return own;
    let sum = 0;
    for (const child of childrenOf(path)) sum += total(child);
    return sum;
  };
  for (const top of childrenOf("")) {
    const children = childrenOf(top);
    if (top === "gpu") {
      // The GPU stream's owners are the passes: "gpu/globe" is the globe's.
      for (const child of children) {
        const amount = total(child);
        if (amount > 0) gpu.set(child.slice(top.length + 1), amount);
      }
      const own = sections.get(top);
      if (!children.length && own !== undefined && own > 0) gpu.set(top, own);
      continue;
    }
    if (!children.length) {
      const amount = total(top);
      if (amount > 0) cpu.set(top, amount);
      continue;
    }
    let claimed = 0;
    for (const child of children) {
      const amount = total(child);
      claimed += amount;
      if (amount > 0) cpu.set(child, amount);
    }
    const own = sections.get(top);
    // Time the parent spent outside every child it names, such as Babylon's animations within "render".
    if (own !== undefined && own - claimed > 1e-6) cpu.set(`${top}/${OTHER}`, own - claimed);
  }
  return { cpu, gpu };
}

export function createResourceStreams(options: ResourceStreamsOptions = {}): ResourceStreams {
  const profiler = options.profiler;
  const ownerLimit = Math.max(1, Math.floor(options.ownerLimit ?? DEFAULT_OWNER_LIMIT));
  let sampleMs = Math.max(1, options.sampleMs ?? DEFAULT_STREAM_SAMPLE_MS);
  let seconds = Math.max(1, options.seconds ?? DEFAULT_STREAM_SECONDS);
  let capacity = 0;
  let enabled = false;
  let disposed = false;
  let sampleStart: number | null = null;
  let committed = 0;
  let ends = new Float64Array(0);
  let lengths = new Float64Array(0);
  let frames = new Float64Array(0);
  let problem: string | null = null;
  const sources = new Set<ResourceSource>();
  const kinds = new Map<ResourceKind, KindState>();
  const drained = new Map<string, number>();
  let drainedFrames = 0;

  const fresh = (): void => {
    capacity = Math.max(2, Math.ceil(seconds * 1000 / sampleMs) + 1);
    ends = new Float64Array(capacity);
    lengths = new Float64Array(capacity);
    frames = new Float64Array(capacity);
    committed = 0;
    sampleStart = null;
    problem = null;
    kinds.clear();
    for (const kind of RESOURCE_KINDS) {
      kinds.set(kind, { tracks: new Map(), pending: new Map(), sampleUnavailable: null, sampleNotes: [], unavailable: null, notes: [] });
    }
  };

  const fail = (error: unknown): void => {
    problem = error instanceof Error ? error.message : String(error);
  };

  const sink: ResourceSink = {
    add(kind, owner, amount) {
      if (!Number.isFinite(amount) || amount === 0) return;
      const state = kinds.get(kind);
      if (!state) return;
      state.pending.set(owner, (state.pending.get(owner) ?? 0) + amount);
    },
    unavailable(kind, reason) {
      const state = kinds.get(kind);
      if (state) state.sampleUnavailable = reason;
    },
    note(kind, text) {
      const state = kinds.get(kind);
      if (state && !state.sampleNotes.includes(text)) state.sampleNotes.push(text);
    },
  };

  const keepDrained = (section: string, milliseconds: number): void => {
    drained.set(section, (drained.get(section) ?? 0) + milliseconds);
  };

  const commit = (window: ResourceSampleWindow): void => {
    const slot = committed % capacity;
    const length = window.end - window.start;
    ends[slot] = window.end;
    lengths[slot] = length;
    frames[slot] = drainedFrames;
    for (const [kind, state] of kinds) {
      const scale = isRate(kind) ? 1000 / length : 1;
      for (const [owner, amount] of [...state.pending]) {
        if (owner === OTHER || state.tracks.has(owner)) continue;
        if (state.tracks.size < ownerLimit) {
          state.tracks.set(owner, { values: new Float64Array(capacity), lastSeen: committed });
          continue;
        }
        state.pending.delete(owner);
        state.pending.set(OTHER, (state.pending.get(OTHER) ?? 0) + amount);
      }
      if (state.pending.has(OTHER) && !state.tracks.has(OTHER)) {
        state.tracks.set(OTHER, { values: new Float64Array(capacity), lastSeen: committed });
      }
      for (const [owner, track] of state.tracks) {
        const amount = state.pending.get(owner);
        if (amount === undefined) {
          track.values[slot] = 0;
          if (committed - track.lastSeen >= capacity) state.tracks.delete(owner);
          continue;
        }
        track.values[slot] = amount * scale;
        track.lastSeen = committed;
      }
      state.pending.clear();
      state.unavailable = state.sampleUnavailable;
      state.notes = state.sampleNotes;
      state.sampleUnavailable = null;
      state.sampleNotes = [];
    }
    committed++;
  };

  const close = (end: number): void => {
    const started = profiler?.clock() ?? 0;
    const window = { start: sampleStart!, end };
    const measured = new Set<ResourceKind>();
    drained.clear();
    drainedFrames = 0;
    if (profiler?.drain) {
      measured.add("cpu").add("gpu");
      drainedFrames = profiler.drain(keepDrained);
      const owners = sectionOwners(drained);
      for (const [owner, milliseconds] of owners.cpu) sink.add("cpu", owner, milliseconds);
      for (const [owner, milliseconds] of owners.gpu) sink.add("gpu", owner, milliseconds);
    } else {
      const reason = "The host's profiler keeps no time series to sample.";
      sink.unavailable("cpu", reason);
      sink.unavailable("gpu", reason);
    }
    for (const source of sources) {
      for (const kind of source.kinds ?? []) measured.add(kind);
      try { source.sample(sink, window); } catch (error) { fail(error); }
    }
    for (const [kind, state] of kinds) {
      if (!measured.has(kind) && state.pending.size === 0 && state.sampleUnavailable === null) state.sampleUnavailable = "Nothing in this app measures it.";
    }
    commit(window);
    sampleStart = end;
    profiler?.add(STREAMS_SECTION, started);
  };

  const startSource = (source: ResourceSource): void => {
    try { source.start?.(); } catch (error) { fail(error); }
  };
  const stopSource = (source: ResourceSource): void => {
    try { source.stop?.(); } catch (error) { fail(error); }
  };

  const setEnabled = (next: boolean): void => {
    if (disposed || next === enabled) return;
    enabled = next;
    if (next) {
      fresh();
      for (const source of sources) startSource(source);
    } else {
      for (const source of sources) stopSource(source);
      sampleStart = null;
    }
  };

  const empty = new Float64Array(0);

  return {
    get enabled() {
      return enabled;
    },
    setEnabled,
    get sampleMs() {
      return sampleMs;
    },
    get seconds() {
      return seconds;
    },
    configure(next) {
      const nextSampleMs = Math.max(1, next.sampleMs ?? sampleMs);
      const nextSeconds = Math.max(1, next.seconds ?? seconds);
      if (nextSampleMs === sampleMs && nextSeconds === seconds) return;
      sampleMs = nextSampleMs;
      seconds = nextSeconds;
      if (enabled) fresh();
    },
    register(source) {
      if (disposed) return () => undefined;
      sources.add(source);
      if (enabled) startSource(source);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        sources.delete(source);
        if (enabled) stopSource(source);
      };
    },
    update(now) {
      if (!enabled) return;
      if (sampleStart === null) {
        sampleStart = now;
        return;
      }
      if (now - sampleStart < sampleMs) return;
      close(now);
    },
    stream(kind) {
      const state = kinds.get(kind);
      const count = Math.min(committed, capacity);
      const ordered = (ring: Float64Array): Float64Array => {
        const out = new Float64Array(count);
        for (let index = 0; index < count; index++) out[index] = ring[(committed - count + index) % capacity];
        return out;
      };
      if (!state || count === 0) {
        return { kind, unit: RESOURCE_UNITS[kind], ends: empty, lengths: empty, frames: empty, layers: [], unavailable: state?.unavailable ?? null, notes: state?.notes ?? [] };
      }
      return {
        kind,
        unit: RESOURCE_UNITS[kind],
        ends: ordered(ends),
        lengths: ordered(lengths),
        frames: ordered(frames),
        layers: [...state.tracks].map(([owner, track]) => ({ owner, values: ordered(track.values) })),
        unavailable: state.unavailable,
        notes: state.notes,
      };
    },
    problem: () => problem,
    dispose() {
      if (disposed) return;
      setEnabled(false);
      disposed = true;
      sources.clear();
    },
  };
}
