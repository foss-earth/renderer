import type { ResourceSource } from "./resourceStreams.js";

export interface MemorySourceOptions {
  /** The page's JavaScript heap in use, in bytes, or null where the browser does not say. */
  heapBytes?(): number | null;
}

export interface MemoryOwnerOptions {
  /**
   * Its bytes are part of the JavaScript heap, as typed arrays are in
   * Chromium, so the heap's rest leaves them out. Images, canvases and
   * storage are not.
   */
  inHeap?: boolean;
}

export interface MemorySource extends ResourceSource {
  /**
   * Adds an owner that knows what it holds in main memory, read once per
   * sample while measuring. Returns a function that removes it.
   */
  track(owner: string, bytes: () => number | null, options?: MemoryOwnerOptions): () => void;
}

/** The heap layer: what the JavaScript heap holds beyond the owners that count their own bytes in it. */
export const HEAP_REST = "JavaScript heap, rest";

/**
 * Main memory by owner. Owners count what they hold; the browser's heap
 * figure, where it gives one, adds a layer for the rest of the heap. Where it
 * gives none, only the owners show and a note says so. A figure the browser
 * rounds or updates rarely is drawn as it comes.
 */
export function createMemorySource(options: MemorySourceOptions = {}): MemorySource {
  const owners = new Set<{ owner: string; bytes: () => number | null; inHeap: boolean }>();
  return {
    kinds: ["ram"],
    sample(sink) {
      let inHeap = 0;
      for (const entry of owners) {
        let bytes: number | null;
        try { bytes = entry.bytes(); } catch { bytes = null; }
        if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) continue;
        sink.add("ram", entry.owner, bytes);
        if (entry.inHeap) inHeap += bytes;
      }
      const heap = options.heapBytes?.() ?? null;
      if (heap !== null && Number.isFinite(heap)) sink.add("ram", HEAP_REST, Math.max(0, heap - inHeap));
      else sink.note("ram", "This browser does not report its JavaScript heap, so only owners that count their own bytes show.");
    },
    track(owner, bytes, trackOptions = {}) {
      const entry = { owner, bytes, inHeap: trackOptions.inHeap ?? false };
      owners.add(entry);
      return () => { owners.delete(entry); };
    },
  };
}
