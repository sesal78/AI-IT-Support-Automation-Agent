import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("allows `limit` hits per key and blocks the next one", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 600_000, now: c.now });
    for (let i = 0; i < 5; i++) expect(limiter.hit("1.2.3.4")).toBe(true);
    expect(limiter.hit("1.2.3.4")).toBe(false);
  });

  it("counts each key separately", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock().now });
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("b")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
  });

  it("allows hits again once the oldest one leaves the window", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: c.now });
    expect(limiter.hit("a")).toBe(true);
    c.advance(500);
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
    c.advance(500);
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
  });

  it("does not count blocked hits against the window", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: c.now });
    expect(limiter.hit("a")).toBe(true);
    c.advance(900);
    expect(limiter.hit("a")).toBe(false);
    c.advance(100);
    expect(limiter.hit("a")).toBe(true);
  });

  it("evicts keys whose hits have all expired", () => {
    const c = clock();
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, now: c.now });
    for (let i = 0; i < 100; i++) limiter.hit(`ip-${i}`);
    expect(limiter.size()).toBe(100);
    c.advance(1000);
    limiter.hit("fresh");
    expect(limiter.size()).toBe(1);
  });

  it("never tracks more than maxKeys keys, dropping the oldest first", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: clock().now, maxKeys: 3 });
    for (const key of ["a", "b", "c", "d"]) limiter.hit(key);
    expect(limiter.size()).toBe(3);
    // "a" was evicted, so it starts a fresh window; "d" is still tracked.
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("d")).toBe(false);
  });
});
