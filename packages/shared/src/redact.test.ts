import { describe, expect, it } from "vitest";
import { redact } from "./index.js";

// Secret-shaped fixtures are assembled at runtime so the literal
// "keyword: value" text never appears in the repo (CI runs gitleaks over the
// full history). All values below are obviously fake.
const kv = (key: string, sep: string, value: string) => key + sep + value;

// Obviously fake PII: the Visa test card, example.com / x.com mail, TEST-NET
// IPs (RFC 5737), 555 phone numbers and the documented example TFN.
const fixtures: string[] = [
  "mail jo@x.com or call +61 412 345 678",
  "card 4111 1111 1111 1111 ssn 123-45-6789",
  "card 4111-1111-1111-1111 or 4111111111111111",
  "amex 3782 822463 10005 expires soon",
  "not a card 4111 1111 1111 1112",
  kv("password", ": ", "hunter2"),
  kv("my api key", " = ", "notreal"),
  kv("client_secret", "=", "fake"),
  kv("token", ":", '"two words"'),
  "INC0012345 on 2026-09-28 at 10:15, version 1.2.3",
  "call 0412 345 678 about my laptop",
  "office (02) 9876 5432 or 1800 123 456",
  "US desk (555) 555-0199, 555-555-0123 or 1-800-555-0199",
  "server 192.0.2.10 and 198.51.100.255 are down.",
  "tfn 123 456 782 and 123456782",
  "not a tfn 123 456 789",
  "First.Last+tag@mail.example.com wrote",
  "",
  "plain text with no personal data",
];

describe("redact", () => {
  it("redacts email and international phone with a per-type log", () => {
    expect(redact("mail jo@x.com or call +61 412 345 678")).toEqual({
      text: "mail [REDACTED_EMAIL] or call [REDACTED_PHONE]",
      log: [
        { type: "EMAIL", count: 1 },
        { type: "PHONE", count: 1 },
      ],
    });
  });

  it("redacts a Luhn-valid card and an SSN", () => {
    const out = redact("card 4111 1111 1111 1111 ssn 123-45-6789");
    expect(out.text).toBe("card [REDACTED_CARD] ssn [REDACTED_SSN]");
    expect(out.log).toEqual([
      { type: "CARD", count: 1 },
      { type: "SSN", count: 1 },
    ]);
  });

  it("redacts dashed, contiguous and Amex-grouped cards", () => {
    expect(redact("card 4111-1111-1111-1111 or 4111111111111111").text).toBe(
      "card [REDACTED_CARD] or [REDACTED_CARD]",
    );
    expect(redact("amex 3782 822463 10005 expires soon").text).toBe(
      "amex [REDACTED_CARD] expires soon",
    );
  });

  it("does not redact a 16-digit number that fails the Luhn check", () => {
    for (const input of ["not a card 4111 1111 1111 1112", "ref 4111111111111112"]) {
      const out = redact(input);
      expect(out.text).toBe(input);
      expect(out.log.find((e) => e.type === "CARD")).toBeUndefined();
    }
  });

  it("redacts a secret and never logs its value", () => {
    const out = redact(kv("password", ": ", "hunter2"));
    expect(out.text).toBe("[REDACTED_SECRET]");
    expect(out.log).toEqual([{ type: "SECRET", count: 1 }]);
    expect(JSON.stringify(out.log)).not.toContain("hunter2");
  });

  it("redacts other secret keyword forms", () => {
    expect(redact(kv("my api key", " = ", "notreal")).text).toBe("my [REDACTED_SECRET]");
    expect(redact(kv("client_secret", "=", "fake")).text).toBe("[REDACTED_SECRET]");
    expect(redact(kv("PWD", ":", "x") + " ok").text).toBe("[REDACTED_SECRET] ok");
    expect(redact(kv("token", ":", '"two words"') + " end").text).toBe("[REDACTED_SECRET] end");
  });

  it("leaves ticket-style text unchanged", () => {
    const input = "INC0012345 on 2026-09-28 at 10:15, version 1.2.3";
    expect(redact(input)).toEqual({ text: input, log: [] });
  });

  it("redacts AU and US phone formats", () => {
    expect(redact("call 0412 345 678 about my laptop").text).toBe(
      "call [REDACTED_PHONE] about my laptop",
    );
    expect(redact("office (02) 9876 5432 or 1800 123 456").text).toBe(
      "office [REDACTED_PHONE] or [REDACTED_PHONE]",
    );
    const us = redact("US desk (555) 555-0199, 555-555-0123 or 1-800-555-0199");
    expect(us.text).toBe("US desk [REDACTED_PHONE], [REDACTED_PHONE] or [REDACTED_PHONE]");
    expect(us.log).toEqual([{ type: "PHONE", count: 3 }]);
  });

  it("redacts IPv4 addresses but not version numbers", () => {
    expect(redact("server 192.0.2.10 and 198.51.100.255 are down.").text).toBe(
      "server [REDACTED_IPV4] and [REDACTED_IPV4] are down.",
    );
    expect(redact("upgrade to 10.2.3 now").text).toBe("upgrade to 10.2.3 now");
    expect(redact("bad 999.1.1.1").text).toBe("bad 999.1.1.1");
  });

  it("redacts a TFN only when the checksum passes", () => {
    expect(redact("tfn 123 456 782 and 123456782").text).toBe(
      "tfn [REDACTED_AU_TFN] and [REDACTED_AU_TFN]",
    );
    expect(redact("not a tfn 123 456 789").text).toBe("not a tfn 123 456 789");
  });

  it("is idempotent over every fixture", () => {
    for (const input of fixtures) {
      const once = redact(input).text;
      expect(redact(once).text).toBe(once);
    }
  });

  it("returns an empty result for an empty string", () => {
    expect(redact("")).toEqual({ text: "", log: [] });
  });

  it("throws a TypeError for non-string input", () => {
    for (const bad of [undefined, null, 42, {}, ["a"]]) {
      expect(() => redact(bad as unknown as string)).toThrow(TypeError);
    }
  });

  it("completes quickly on long adversarial input", () => {
    const inputs = [
      "a".repeat(100_000),
      "1".repeat(100_000),
      "1 ".repeat(50_000),
      "1-".repeat(50_000),
      "1.".repeat(50_000),
      "+1 ".repeat(30_000),
      "a@".repeat(50_000),
      "a@" + "a.".repeat(50_000),
      "password".repeat(10_000),
      "x".repeat(50_000) + "@" + "y".repeat(50_000),
    ];
    const start = performance.now();
    for (const input of inputs) redact(input);
    expect(performance.now() - start).toBeLessThan(2_000);
  });
});
