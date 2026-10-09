/** Milliseconds and dimensionless growth; expose these values in the host's settings. */
export interface ReadinessPolicy {
  firstCheckIntervalMs: number;
  maxCheckIntervalMs: number;
  backoffFactor: number;
}

/** The existing scene readiness policy, preserved from the source implementation. */
export const defaultReadinessPolicy: Readonly<ReadinessPolicy> = Object.freeze({
  firstCheckIntervalMs: 16,
  maxCheckIntervalMs: 250,
  backoffFactor: 1.5,
});

export interface ReadinessTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Check without drawing. A newly settled resource restores the first interval;
 * unchanged work backs off. Cancellation prevents a queued check from settling.
 * The host supplies timers, and this function never creates a render authority.
 */
export function checkUntilSettled(
  pendingNow: number,
  pending: () => number,
  settled: () => void,
  timers: ReadinessTimers,
  policy: Readonly<ReadinessPolicy> = defaultReadinessPolicy,
): () => void {
  if (!Number.isFinite(policy.firstCheckIntervalMs) || policy.firstCheckIntervalMs <= 0
    || !Number.isFinite(policy.maxCheckIntervalMs) || policy.maxCheckIntervalMs < policy.firstCheckIntervalMs
    || !Number.isFinite(policy.backoffFactor) || policy.backoffFactor < 1) {
    throw new RangeError("Readiness intervals must be positive, maximum >= first, and backoff >= 1.");
  }
  let handle: unknown = null;
  let delay = policy.firstCheckIntervalMs;
  let last = pendingNow;
  let cancelled = false;
  const check = (): void => {
    handle = null;
    if (cancelled) return;
    const now = pending();
    if (now === 0) {
      cancelled = true;
      settled();
      return;
    }
    delay = now < last ? policy.firstCheckIntervalMs : Math.min(policy.maxCheckIntervalMs, delay * policy.backoffFactor);
    last = now;
    handle = timers.setTimeout(check, delay);
  };
  handle = timers.setTimeout(check, delay);
  return () => {
    cancelled = true;
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
}
