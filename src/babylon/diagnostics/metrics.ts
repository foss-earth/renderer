import type { Engine, Scene, WebGPUEngine } from "@babylonjs/core";
/** Host supplies its own feature counts; renderer has no globe culling dependency. */
export interface CullingStats { total: number; visible: number; hidden: number }

export interface TileMetrics {
  visibleTiles: number;
  activeTiles: number;
}

export interface PerformanceSnapshot {
  fps: number;
  frameMs: number;
  p95FrameMs: number;
  activeMeshes: number;
  drawCalls: number | null;
  memoryMb: number | null;
  tiles: TileMetrics | null;
  culling: CullingStats;
}

export interface PerformanceMetricsHandle {
  update(): PerformanceSnapshot;
  getSnapshot(): PerformanceSnapshot;
  format(snapshot?: PerformanceSnapshot): string;
}



export const DEFAULT_FRAME_SAMPLE_COUNT = 120;
const EMPTY_CULLING: CullingStats = { total: 0, visible: 0, hidden: 0 };



/** The value at a rank of an ascending list. */
function percentile(sorted: readonly number[], percentileRank: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileRank));
  return sorted[index];
}

/** Index of the first value in an ascending list that is not below `value`. */
function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0, high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function createPerformanceMetrics(options: {
  now(): number;
  memoryBytes(): number | null;
  /** Number of recent host-observed frame intervals retained; original default 120. */
  frameSampleCount?: number;
  engine: Engine | WebGPUEngine;
  scene: Scene;
  getTileMetrics: () => TileMetrics | null;
  getCullingStats: () => CullingStats;
}): PerformanceMetricsHandle {
  const sampleCount = options.frameSampleCount ?? DEFAULT_FRAME_SAMPLE_COUNT;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) throw new RangeError("Frame sample count must be a positive whole number.");
  // The window in arrival order, and the same values kept in ascending order
  // as they come and go, so that no frame sorts the whole window.
  const frameSamples: number[] = [];
  const sortedSamples: number[] = [];
  let lastTimeMs = options.now();
  let snapshot: PerformanceSnapshot = {
    fps: 0,
    frameMs: 0,
    p95FrameMs: 0,
    activeMeshes: 0,
    drawCalls: null,
    memoryMb: null,
    tiles: null,
    culling: EMPTY_CULLING,
  };

  function update(): PerformanceSnapshot {
    const now = options.now();
    const frameMs = Math.max(0, now - lastTimeMs);
    lastTimeMs = now;

    if (frameMs > 0) {
      frameSamples.push(frameMs);
      sortedSamples.splice(lowerBound(sortedSamples, frameMs), 0, frameMs);
      if (frameSamples.length > sampleCount) {
        sortedSamples.splice(lowerBound(sortedSamples, frameSamples.shift()!), 1);
      }
    }

    const memoryBytes = options.memoryBytes();
    snapshot = {
      fps: options.engine.getFps(),
      frameMs,
      p95FrameMs: percentile(sortedSamples, 0.95),
      activeMeshes: options.scene.getActiveMeshes().length,
      drawCalls: null,
      memoryMb: memoryBytes === null ? null : memoryBytes / 1_048_576,
      tiles: options.getTileMetrics(),
      culling: options.getCullingStats(),
    };
    return snapshot;
  }

  function getSnapshot(): PerformanceSnapshot {
    return snapshot;
  }

  function format(value: PerformanceSnapshot = snapshot): string {
    const tiles = value.tiles ? ` t${value.tiles.visibleTiles}/${value.tiles.activeTiles}` : "";
    const culling = value.culling.total > 0 ? ` c${value.culling.visible}/${value.culling.total}` : "";
    const memory = value.memoryMb !== null ? ` m${Math.round(value.memoryMb)}MB` : "";
    return `Perf: ${Math.round(value.fps)}fps ${value.frameMs.toFixed(1)}ms p95 ${value.p95FrameMs.toFixed(1)}ms a${value.activeMeshes}${tiles}${culling}${memory}`;
  }

  return { update, getSnapshot, format };
}