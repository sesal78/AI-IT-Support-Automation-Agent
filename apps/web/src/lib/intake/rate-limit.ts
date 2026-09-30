export interface RateLimiterOptions {
  /** Hits allowed per key inside one window. */
  limit: number;
  windowMs: number;
  /** Injectable clock (ms), for tests. */
  now?: () => number;
  /** Upper bound on tracked keys; the least recently hit key is dropped first. */
  maxKeys?: number;
}

/**
 * In-memory sliding-window limiter, per process (the web app runs one replica).
 * Memory is bounded: expired keys are swept on each hit and at most `maxKeys`
 * keys (each holding at most `limit` timestamps) are kept.
 */
export function createRateLimiter({
  limit,
  windowMs,
  now = Date.now,
  maxKeys = 10_000,
}: RateLimiterOptions) {
  // Map order = least recently hit first (a key is re-inserted on each allowed hit).
  const hits = new Map<string, number[]>();

  function sweep(cutoff: number) {
    for (const [key, times] of hits) {
      if (times[times.length - 1]! <= cutoff) hits.delete(key);
    }
  }

  return {
    /** Records a hit for `key`; returns false (and records nothing) when over the limit. */
    hit(key: string): boolean {
      const at = now();
      const cutoff = at - windowMs;
      sweep(cutoff);
      const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (recent.length >= limit) return false;
      recent.push(at);
      hits.delete(key);
      hits.set(key, recent);
      while (hits.size > maxKeys) {
        hits.delete(hits.keys().next().value!);
      }
      return true;
    },
    /** Number of keys currently tracked. */
    size(): number {
      return hits.size;
    },
  };
}
