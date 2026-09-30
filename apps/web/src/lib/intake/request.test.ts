import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clientIp, idempotencyKey } from "./request";

function headers(init: Record<string, string>) {
  return new Headers(init);
}

describe("clientIp", () => {
  it("prefers cf-connecting-ip", () => {
    expect(
      clientIp(headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" })),
    ).toBe("203.0.113.7");
  });

  it("falls back to the first x-forwarded-for entry", () => {
    expect(clientIp(headers({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" }))).toBe(
      "198.51.100.1",
    );
  });

  it("returns null when neither header is set", () => {
    expect(clientIp(headers({}))).toBeNull();
    expect(clientIp(headers({ "x-forwarded-for": " " }))).toBeNull();
  });
});

describe("idempotencyKey", () => {
  const body = { email: "Jo@Example.com", title: "Printer", description: "It jams on page two." };
  const at = new Date("2026-09-30T23:59:00Z");

  it("uses the Idempotency-Key header when present", () => {
    expect(idempotencyKey(headers({ "idempotency-key": "  abc-123 " }), body, at)).toBe("abc-123");
  });

  it("hashes email + title + description + UTC date otherwise", () => {
    const expected = createHash("sha256")
      .update(JSON.stringify(["jo@example.com", body.title, body.description, "2026-09-30"]))
      .digest("hex");
    expect(idempotencyKey(headers({}), body, at)).toBe(expected);
  });

  it("gives a different key on a different UTC day", () => {
    const nextDay = new Date("2026-10-01T00:00:01Z");
    expect(idempotencyKey(headers({}), body, at)).not.toBe(
      idempotencyKey(headers({}), body, nextDay),
    );
  });

  it("ignores an empty header", () => {
    expect(idempotencyKey(headers({ "idempotency-key": "  " }), body, at)).toHaveLength(64);
  });

  it("hashes an over-long header so the stored key stays bounded", () => {
    const long = "k".repeat(500);
    const key = idempotencyKey(headers({ "idempotency-key": long }), body, at);
    expect(key).toBe(`h:${createHash("sha256").update(long).digest("hex")}`);
  });
});
