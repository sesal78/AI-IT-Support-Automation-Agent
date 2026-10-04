import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clientIp, idempotencyKey, namespacedKey } from "./request";

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
    expect(idempotencyKey(headers({ "idempotency-key": "  abc-123 " }), body, at)).toBe(
      "web:abc-123",
    );
  });

  // T3.U.07: a prefix sent by the client is never trusted and never stripped.
  it.each([
    ["abc", "web:abc"],
    ["email:abc", "web:email:abc"],
    ["test:abc", "web:test:abc"],
    ["web:abc", "web:web:abc"],
  ])("puts the header %s under the web namespace", (header, expected) => {
    expect(idempotencyKey(headers({ "idempotency-key": header }), body, at)).toBe(expected);
  });

  it("T3.U.07: never returns a key in another channel's namespace for 100 header values", () => {
    const prefixes = [
      "email:",
      "test:",
      " email:",
      "EMAIL:",
      "	test:",
      "Test:",
      "web:",
      ":",
      "h:",
      "",
    ];
    const tails = [
      "x",
      "",
      ";x",
      "-email:x",
      "<id@mail.example>",
      " x ",
      "k".repeat(199),
      "k".repeat(201),
      "0",
      "%C3%A9",
    ];
    const values = prefixes.flatMap((prefix) => tails.map((tail) => `${prefix}${tail}`));
    expect(new Set(values).size).toBe(100);
    for (const value of values) {
      const key = idempotencyKey(headers({ "idempotency-key": value }), body, at);
      expect(key.startsWith("web:")).toBe(true);
      expect(key.startsWith("email:")).toBe(false);
      expect(key.startsWith("test:")).toBe(false);
    }
  });

  it("hashes email + title + description + UTC date otherwise", () => {
    const expected = createHash("sha256")
      .update(JSON.stringify(["jo@example.com", body.title, body.description, "2026-09-30"]))
      .digest("hex");
    expect(idempotencyKey(headers({}), body, at)).toBe(`web:${expected}`);
  });

  it("gives a different key on a different UTC day", () => {
    const nextDay = new Date("2026-10-01T00:00:01Z");
    expect(idempotencyKey(headers({}), body, at)).not.toBe(
      idempotencyKey(headers({}), body, nextDay),
    );
  });

  it("ignores an empty header", () => {
    expect(idempotencyKey(headers({ "idempotency-key": "  " }), body, at)).toHaveLength(68);
  });

  it.each([
    ["an empty header", ""],
    ["a header of spaces only", "   "],
  ])("falls back to the web-namespaced body hash for %s", (_label, header) => {
    expect(idempotencyKey(headers({ "idempotency-key": header }), body, at)).toBe(
      idempotencyKey(headers({}), body, at),
    );
    expect(idempotencyKey(headers({}), body, at)).toMatch(/^web:[0-9a-f]{64}$/);
  });

  it("hashes an over-long header so the stored key stays bounded", () => {
    const long = "k".repeat(500);
    const key = idempotencyKey(headers({ "idempotency-key": long }), body, at);
    expect(key).toBe(`web:h:${createHash("sha256").update(long).digest("hex")}`);
  });

  it("keeps a header of exactly 200 characters and hashes one of 201", () => {
    const at200 = "k".repeat(200);
    expect(idempotencyKey(headers({ "idempotency-key": at200 }), body, at)).toBe(`web:${at200}`);
    const at201 = "k".repeat(201);
    expect(idempotencyKey(headers({ "idempotency-key": at201 }), body, at)).toBe(
      `web:h:${createHash("sha256").update(at201).digest("hex")}`,
    );
  });
});

describe("namespacedKey", () => {
  it.each([
    ["web", "abc", "web:abc"],
    ["email", "<id@mail.example>", "email:<id@mail.example>"],
    ["test", "run-1", "test:run-1"],
  ] as const)("prefixes the %s namespace", (namespace, raw, expected) => {
    expect(namespacedKey(namespace, raw)).toBe(expected);
  });

  it("does not strip a prefix already in the raw value", () => {
    expect(namespacedKey("web", "email:abc")).toBe("web:email:abc");
  });

  it.each(["slack", "", "WEB", "email:", "toString"])(
    "throws a TypeError for the unknown namespace %j",
    (namespace) => {
      // Deliberate cast: the namespace type is closed, so a bad value needs one to compile.
      const call = () => namespacedKey(namespace as "web", "abc");
      expect(call).toThrow(TypeError);
      expect(call).toThrow("unknown idempotency namespace");
    },
  );

  it("throws a TypeError for an empty raw key", () => {
    const call = () => namespacedKey("email", "");
    expect(call).toThrow(TypeError);
    expect(call).toThrow("empty idempotency key");
  });
});
