import type { ResourceSource } from "./resourceStreams.js";

/** What the network source reads from a Resource Timing entry. */
export interface ResourceTimingEntry {
  readonly name: string;
  readonly initiatorType: string;
  /** Bytes received, headers included: 0 from a cache, and 0 when a cross-origin server does not allow timing. */
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
  /** 0 when a cross-origin server does not allow timing. */
  readonly responseStart: number;
}

export interface NetworkSourceOptions {
  /** Delivers requests as they finish, from when measuring starts; returns a function that stops. */
  observe(listener: (entries: readonly ResourceTimingEntry[]) => void): () => void;
  /** The owner of a request, from its URL and what started it; null counts it as "other". */
  owner(url: string, initiatorType: string): string | null;
  /**
   * Owners whose bytes the host counts itself with `received`, such as tiles
   * from servers that hide their sizes; their entries add no bytes, so
   * nothing is counted twice.
   */
  metered?: readonly string[];
}

export interface NetworkSource extends ResourceSource {
  /** Bytes of a response the host counted itself, such as a body streamed through a counter; ignored while not measuring. */
  received(owner: string, bytes: number): void;
  /** Whether measuring is on, so a host can leave its responses alone otherwise. */
  readonly measuring: boolean;
}

/**
 * Bytes received per second by owner. The page's Resource Timing names every
 * request; its sizes count where the server allows it, and a host counts the
 * rest itself. A request served from a cache receives nothing. Requests whose
 * size stays hidden are counted and named in a note, never guessed at.
 */
export function createNetworkSource(options: NetworkSourceOptions): NetworkSource {
  const metered = new Set(options.metered ?? []);
  const received = new Map<string, number>();
  const hidden = new Map<string, number>();
  let stop: (() => void) | null = null;
  const add = (totals: Map<string, number>, owner: string, amount: number): void => {
    totals.set(owner, (totals.get(owner) ?? 0) + amount);
  };
  const take = (entries: readonly ResourceTimingEntry[]): void => {
    for (const entry of entries) {
      const owner = options.owner(entry.name, entry.initiatorType) ?? "other";
      if (metered.has(owner)) continue;
      if (entry.transferSize > 0) add(received, owner, entry.transferSize);
      else if (entry.responseStart === 0 && entry.encodedBodySize === 0 && entry.decodedBodySize === 0) add(hidden, owner, 1);
    }
  };
  const clear = (): void => {
    received.clear();
    hidden.clear();
  };
  return {
    kinds: ["network"],
    get measuring() {
      return stop !== null;
    },
    start() {
      clear();
      stop = options.observe(take);
    },
    sample(sink) {
      for (const [owner, bytes] of received) sink.add("network", owner, bytes);
      received.clear();
      if (hidden.size) {
        const counts = [...hidden].sort((left, right) => right[1] - left[1]).map(([owner, count]) => `${count} to ${owner}`).join(", ");
        sink.note("network", `Requests whose server hides their size, left out: ${counts}.`);
      }
    },
    stop() {
      const detach = stop;
      stop = null;
      clear();
      detach?.();
    },
    received(owner, bytes) {
      if (stop && Number.isFinite(bytes) && bytes > 0) add(received, owner, bytes);
    },
  };
}
