import { describe, expect, it } from "vitest";
import { turnstileSiteKey } from "./site-key";

describe("turnstileSiteKey", () => {
  it("returns TURNSTILE_SITE_KEY from the given env", () => {
    expect(turnstileSiteKey({ TURNSTILE_SITE_KEY: "site-key-123" })).toBe("site-key-123");
  });

  it("reads process.env by default", () => {
    // Set for every web test in apps/web/vitest.config.ts.
    expect(turnstileSiteKey()).toBe("fake-turnstile-site-key");
  });

  it("throws naming TURNSTILE_SITE_KEY when it is unset or empty", () => {
    expect(() => turnstileSiteKey({})).toThrow(/TURNSTILE_SITE_KEY/);
    expect(() => turnstileSiteKey({ TURNSTILE_SITE_KEY: "" })).toThrow(/TURNSTILE_SITE_KEY/);
  });
});
