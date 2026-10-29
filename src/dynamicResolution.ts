/**
 * Steers an internal render scale from GPU frame time.
 *
 * The scale drops quickly when the GPU is over budget and climbs one step at a
 * time only when the next step is predicted to stay well under budget, so the
 * two do not chase each other. A frame the CPU already missed does not lower
 * the scale while the GPU is comfortably inside its share.
 */

export interface DynamicResolutionOptions {
  /** Lowest scale. Default 0.5. */
  minScale?: number;
  /** Highest scale, normally the user's resolution scale. Default 1. */
  maxScale?: number;
  /** Quantized step between those limits. Default 0.05. */
  step?: number;
  /** Frame rate the budget is built from. Default 60. */
  targetFps?: number;
  /** Fraction of the frame reserved for the GPU. Default 0.8. */
  gpuBudgetShare?: number;
  /** Consecutive over-budget GPU frames before a drop. Default 3. */
  downFrames?: number;
  /** Consecutive comfortable frames before a one-step rise. Default 45. */
  upFrames?: number;
  /** Timed frames to wait after a change. Default 8. */
  cooldownFrames?: number;
  /** A drop aims at this fraction of the GPU budget. Default 0.85. */
  downHeadroom?: number;
  /** The next step up must be predicted under this fraction. Default 0.75. */
  upHeadroom?: number;
  /**
   * GPU time at or below this fraction of the GPU budget is not a reason to
   * drop resolution. Default 0.75.
   */
  cpuBoundGpuFraction?: number;
  /** Starting scale, snapped onto a step. Defaults to the ceiling. */
  initialScale?: number;
}

export interface DynamicResolutionSample {
  /** GPU frame time in milliseconds. Zero or negative frames are ignored. */
  gpuMs: number;
  /** Main-thread time for the frame, in milliseconds. */
  cpuMs: number;
  /** Resize, pause, or another frame that must not move the scale. */
  ignore?: boolean;
}

const DEFAULT_MIN_SCALE = 0.5;
const DEFAULT_MAX_SCALE = 1;
const DEFAULT_STEP = 0.05;
const DEFAULT_TARGET_FPS = 60;
const DEFAULT_GPU_SHARE = 0.8;
const DEFAULT_DOWN_FRAMES = 3;
const DEFAULT_UP_FRAMES = 45;
const DEFAULT_COOLDOWN_FRAMES = 8;
const DEFAULT_DOWN_HEADROOM = 0.85;
const DEFAULT_UP_HEADROOM = 0.75;
const DEFAULT_CPU_BOUND_GPU_FRACTION = 0.75;

/** Shown when dynamic resolution is on but the device cannot time the GPU. */
export const DYNAMIC_RESOLUTION_UNTIMED_NOTE = "Unavailable: this browser or GPU does not expose GPU frame timestamps.";

function finite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function snap(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function buildRungs(minScale: number, maxScale: number, step: number): number[] {
  const min = Math.min(minScale, maxScale);
  const max = Math.max(minScale, maxScale);
  if (!(step > 0) || max - min <= 1e-8) return [snap(max)];
  const rungs: number[] = [];
  const count = Math.floor((max - min) / step + 1e-6);
  for (let index = 0; index <= count; index += 1) rungs.push(snap(min + index * step));
  const last = rungs[rungs.length - 1] ?? max;
  if (max - last > step * 0.25) rungs.push(snap(max));
  else rungs[rungs.length - 1] = snap(max);
  return rungs;
}

/** Quantized, hysteretic render-scale governor. No DOM or GPU types. */
export class DynamicResolutionController {
  private min: number;
  private max: number;
  private step: number;
  private fps: number;
  private readonly gpuBudgetShare: number;
  private readonly downFrames: number;
  private readonly upFrames: number;
  private readonly cooldownFrames: number;
  private readonly downHeadroom: number;
  private readonly upHeadroom: number;
  private readonly cpuBoundGpuFraction: number;
  private rungs: number[];
  private current: number;
  private downStreak = 0;
  private upStreak = 0;
  private cooldown = 0;

  constructor(options: DynamicResolutionOptions = {}) {
    this.step = finite(options.step, DEFAULT_STEP) > 0 ? finite(options.step, DEFAULT_STEP) : DEFAULT_STEP;
    this.gpuBudgetShare = finite(options.gpuBudgetShare, DEFAULT_GPU_SHARE) > 0 ? finite(options.gpuBudgetShare, DEFAULT_GPU_SHARE) : DEFAULT_GPU_SHARE;
    this.downFrames = Math.max(1, Math.round(finite(options.downFrames, DEFAULT_DOWN_FRAMES)));
    this.upFrames = Math.max(1, Math.round(finite(options.upFrames, DEFAULT_UP_FRAMES)));
    this.cooldownFrames = Math.max(0, Math.round(finite(options.cooldownFrames, DEFAULT_COOLDOWN_FRAMES)));
    this.downHeadroom = finite(options.downHeadroom, DEFAULT_DOWN_HEADROOM);
    this.upHeadroom = finite(options.upHeadroom, DEFAULT_UP_HEADROOM);
    this.cpuBoundGpuFraction = finite(options.cpuBoundGpuFraction, DEFAULT_CPU_BOUND_GPU_FRACTION);
    this.fps = DEFAULT_TARGET_FPS;
    this.min = DEFAULT_MIN_SCALE;
    this.max = DEFAULT_MAX_SCALE;
    this.rungs = [DEFAULT_MAX_SCALE];
    this.current = DEFAULT_MAX_SCALE;
    this.setLimits(finite(options.minScale, DEFAULT_MIN_SCALE), finite(options.maxScale, DEFAULT_MAX_SCALE));
    this.setTargetFps(finite(options.targetFps, DEFAULT_TARGET_FPS));
    if (options.initialScale !== undefined) this.current = this.clampToRungs(options.initialScale);
    this.downStreak = 0;
    this.upStreak = 0;
    this.cooldown = 0;
  }

  get scale(): number { return this.current; }
  get minScale(): number { return this.min; }
  get maxScale(): number { return this.max; }
  get targetFps(): number { return this.fps; }
  /** GPU share of the frame, in milliseconds. */
  get targetGpuMs(): number { return (1000 / this.fps) * this.gpuBudgetShare; }

  /** Moves the allowed range. The current scale is clamped onto a step immediately. */
  setLimits(minScale: number, maxScale: number): void {
    const min = finite(minScale, this.min);
    const max = finite(maxScale, this.max);
    const same = min === this.min && max === this.max && this.rungs.length > 0;
    this.min = Math.min(min, max);
    this.max = Math.max(min, max);
    this.rungs = buildRungs(this.min, this.max, this.step);
    const next = this.clampToRungs(this.current);
    if (next !== this.current) {
      this.current = next;
      this.downStreak = 0;
      this.upStreak = 0;
      this.cooldown = this.cooldownFrames;
    } else if (!same) {
      this.downStreak = 0;
      this.upStreak = 0;
    }
  }

  setTargetFps(fps: number): void {
    const next = finite(fps, this.fps);
    if (!(next > 0) || next === this.fps) return;
    this.fps = next;
    this.downStreak = 0;
    this.upStreak = 0;
  }

  /** Considers one frame and returns the scale to draw with afterwards. */
  observe(sample: DynamicResolutionSample): number {
    if (sample.ignore || !(sample.gpuMs > 0)) return this.current;
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      this.downStreak = 0;
      this.upStreak = 0;
      return this.current;
    }
    const frameBudget = 1000 / this.fps;
    const gpuBudget = this.targetGpuMs;
    const cpuBound = sample.cpuMs >= frameBudget && sample.gpuMs <= gpuBudget * this.cpuBoundGpuFraction;
    if (cpuBound) {
      this.downStreak = 0;
      this.upStreak = 0;
      return this.current;
    }
    if (sample.gpuMs > gpuBudget) {
      this.upStreak = 0;
      this.downStreak += 1;
      if (this.downStreak >= this.downFrames) {
        const next = this.stepDown(sample.gpuMs, gpuBudget);
        this.downStreak = 0;
        this.upStreak = 0;
        if (next !== this.current) {
          this.current = next;
          this.cooldown = this.cooldownFrames;
        }
      }
      return this.current;
    }
    this.downStreak = 0;
    const next = this.nextHigher();
    if (next !== null && sample.gpuMs * (next / this.current) ** 2 <= this.upHeadroom * gpuBudget) {
      this.upStreak += 1;
      if (this.upStreak >= this.upFrames) {
        this.current = next;
        this.downStreak = 0;
        this.upStreak = 0;
        this.cooldown = this.cooldownFrames;
      }
    } else {
      this.upStreak = 0;
    }
    return this.current;
  }

  reset(): void {
    this.current = this.rungs[this.rungs.length - 1] ?? this.max;
    this.downStreak = 0;
    this.upStreak = 0;
    this.cooldown = 0;
  }

  private clampToRungs(scale: number): number {
    const ceiling = this.rungs[this.rungs.length - 1] ?? this.max;
    const floor = this.rungs[0] ?? this.min;
    const clamped = Math.min(ceiling, Math.max(floor, finite(scale, ceiling)));
    let chosen = floor;
    for (const rung of this.rungs) if (rung <= clamped + 1e-8) chosen = rung;
    return chosen;
  }

  private nextHigher(): number | null {
    for (const rung of this.rungs) if (rung > this.current + 1e-8) return rung;
    return null;
  }

  /** Highest step whose quadratic pixel cost fits the drop target, and at least one step down. */
  private stepDown(gpuMs: number, gpuBudget: number): number {
    const limit = this.downHeadroom * gpuBudget;
    const floor = this.rungs[0] ?? this.min;
    let chosen = floor;
    for (const rung of this.rungs) {
      if (rung >= this.current - 1e-8) break;
      if (gpuMs * (rung / this.current) ** 2 <= limit) chosen = rung;
    }
    return chosen < this.current - 1e-8 ? chosen : floor;
  }
}
