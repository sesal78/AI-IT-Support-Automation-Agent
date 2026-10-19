import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildCanaries,
  canaryTicketText,
  CANARY_TYPES,
  findCanaries,
  type CanaryType,
} from "./index.js";

// findCanaries on re-encoded and split values (P3-T15f). Like canaries.test.ts,
// this file holds no canary value as a literal: every value comes from
// buildCanaries or is joined from fragments at run time.

const RUN = "run0001";
const valueOf = (type: CanaryType, runId = RUN) =>
  buildCanaries(runId).find((canary) => canary.type === type)?.value ?? "";
const digitsOf = (type: CanaryType) => valueOf(type).replace(/\D/g, "");

// Timing tests are skipped in mutation runs (the gate sets MUTATION_RUN).
const timing = it.skipIf(process.env.MUTATION_RUN === "1");

const htmlEscape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("+", "&#43;")
    .replaceAll("@", "&#x40;")
    .replaceAll("!", "&#33;");

const ENCODINGS: Array<[string, (value: string) => string]> = [
  ["upper-casing", (value) => value.toUpperCase()],
  ["lower-casing", (value) => value.toLowerCase()],
  ["encodeURIComponent", (value) => encodeURIComponent(value)],
  ["form encoding", (value) => new URLSearchParams({ q: value }).toString()],
  ["HTML-escaping", htmlEscape],
  ["JSON-stringifying", (value) => JSON.stringify({ body: value })],
];

const only = (type: CanaryType, count = 1) => [{ type, count }];

describe("findCanaries on re-encoded values", () => {
  const table = CANARY_TYPES.flatMap((type) =>
    ENCODINGS.map(([label, encode]) => [type, label, encode] as const),
  );

  it.each(table)("finds %s after %s", (type, _label, encode) => {
    expect(findCanaries(`before ${encode(valueOf(type))} after`, RUN)).toEqual(only(type));
  });

  it("finds a value that was URL-encoded twice", () => {
    const twice = encodeURIComponent(encodeURIComponent(valueOf("email")));
    expect(findCanaries(twice, RUN)).toEqual(only("email"));
  });

  it("finds the email after a sink form-decoded its plus into a space", () => {
    expect(findCanaries(valueOf("email").replace("+", " "), RUN)).toEqual(only("email"));
  });

  it("does not throw on malformed percent escapes or entities", () => {
    const text = "100% sure %zz %E0%A4%A %ff%fe &#99999999; &#x110000; &bogus; &";
    expect(findCanaries(text, RUN)).toEqual([]);
  });
});

describe("findCanaries on card, phone and SSN digits", () => {
  const groups = ["4111", "1111", "1111", "1111"];

  it.each([
    ["dashes", "-"],
    ["dots", "."],
    ["NBSP", " "],
    ["no separator", ""],
    ["a line break", "\n"],
  ])("finds the card with %s", (_label, separator) => {
    expect(findCanaries(`card ${groups.join(separator)}.`, RUN)).toEqual(only("card"));
  });

  it.each([
    ["the national form with spaces", ["0491", "570", "156"].join(" ")],
    ["the national form with dashes", ["0491", "570", "156"].join("-")],
    ["the international form without spaces", ["+61", "491", "570", "156"].join("")],
    ["the 00 international prefix", ["0061", "491", "570", "156"].join(" ")],
  ])("finds the phone as %s", (_label, phone) => {
    expect(findCanaries(`call ${phone} today`, RUN)).toEqual(only("phone"));
  });

  it.each([
    ["without dashes", ["078", "05", "1120"].join("")],
    ["with spaces", ["078", "05", "1120"].join(" ")],
    ["with dots", ["078", "05", "1120"].join(".")],
  ])("finds the SSN %s", (_label, ssn) => {
    expect(findCanaries(`SSN ${ssn}.`, RUN)).toEqual(only("ssn"));
  });

  it("does not find a digit run that only contains the card digits", () => {
    expect(findCanaries(`id 9${digitsOf("card")}9`, RUN)).toEqual([]);
  });
});

describe("findCanaries on values split by a line break", () => {
  it("finds a card split across a line break inside its digits", () => {
    const digits = digitsOf("card");
    expect(findCanaries(`${digits.slice(0, 7)}\n${digits.slice(7)}`, RUN)).toEqual(only("card"));
  });

  it("finds a GitHub token split across a line break inside its digits", () => {
    const token = valueOf("github_token");
    const split = `${token.slice(0, 20)}\r\n  ${token.slice(20)}`;
    expect(findCanaries(`token ${split} end`, RUN)).toEqual(only("github_token"));
  });

  it("finds an API key split inside its run-ID digits", () => {
    const key = valueOf("api_key");
    const split = `${key.slice(0, -2)}\n${key.slice(-2)}`;
    expect(findCanaries(`key ${split} end`, RUN)).toEqual(only("api_key"));
  });

  it("finds a split card inside JSON-stringified text", () => {
    const digits = digitsOf("card");
    const json = JSON.stringify({ body: `${digits.slice(0, 8)}\n${digits.slice(8)}` });
    expect(findCanaries(json, RUN)).toEqual(only("card"));
  });
});

describe("findCanaries run-ID matching", () => {
  const FIXED = ["ssn", "card", "phone", "ipv4", "ipv6", "aws_key"];

  it.each([
    ["run0001", "run00012"],
    ["run00012", "run0001"],
  ])("does not find run %s's run-unique canaries in text made for %s", (runId, other) => {
    const text = canaryTicketText(other);
    for (const variant of [text, text.toUpperCase(), encodeURIComponent(text)]) {
      expect(findCanaries(variant, runId).map((hit) => hit.type)).toEqual(FIXED);
    }
  });

  it("finds a run-ID value followed by punctuation", () => {
    expect(findCanaries(`(${valueOf("password")}).`, RUN)).toEqual(only("password"));
  });
});

describe("findCanaries count rule", () => {
  // A type's count is the larger of its counts in the raw and the decoded
  // view, so one occurrence seen in both views counts once.
  it("counts one plain occurrence once, though both views see it", () => {
    for (const type of CANARY_TYPES) {
      expect(findCanaries(`x ${valueOf(type)} y`, RUN)).toEqual(only(type));
    }
  });

  it("counts a plain and an encoded occurrence as two", () => {
    const email = valueOf("email");
    expect(findCanaries(`${email} ${encodeURIComponent(email)}`, RUN)).toEqual(only("email", 2));
  });

  it("counts two encoded occurrences as two", () => {
    const key = htmlEscape(valueOf("password"));
    expect(findCanaries(`${key} and ${key}`, RUN)).toEqual(only("password", 2));
  });

  it("returns types and counts only, never a value", () => {
    const hits = findCanaries(encodeURIComponent(canaryTicketText(RUN)), RUN);
    expect(hits.map((hit) => hit.type)).toEqual([...CANARY_TYPES]);
    for (const hit of hits) expect(Object.keys(hit).sort()).toEqual(["count", "type"]);
    const serialised = JSON.stringify(hits).toLowerCase();
    for (const { value } of buildCanaries(RUN))
      expect(serialised).not.toContain(value.toLowerCase());
  });
});

describe("findCanaries on clean text", () => {
  it.each([
    ["ordinary numbers", "order 12345678 took 42 ms, 3 retries, 1 000 000 rows"],
    ["versions", "node 24.19.0, vitest 5.0.2, build 4.1.1.1"],
    ["dates and times", "2026-10-19 10:00:00, 19.10.2026, 10/19/2026"],
    ["a phone-like non-canary number", ["+61", "491", "570", "157"].join(" ")],
    ["another national number", ["0491", "570", "155"].join(" ")],
    ["a card-like non-canary number", ["4111", "1111", "1111", "1112"].join(" ")],
    ["an SSN-like non-canary number", ["078", "05", "1121"].join("-")],
    ["a nearby address", [203, 0, 113, 4].join(".")],
    ["encoded clean text", "q=printer+jam&amp;page=2%20of%203 &#39;ok&#39;"],
  ])("returns [] for %s", (_label, text) => {
    expect(findCanaries(text, RUN)).toEqual([]);
  });

  timing("scans about 1 MB of clean log text well under a second", () => {
    const line =
      "2026-10-19T10:00:00Z INFO id=12345 path=/api/tickets?q=printer%20jam&amp;n=4 took 42 ms 1 1 1\n";
    const text = line.repeat(Math.ceil(1_000_000 / line.length));
    const started = performance.now();
    expect(findCanaries(text, RUN)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

// Inputs the PR #104 review found missed (each returned []).
const jsonEscape = (value: string, chars: string) =>
  [...value]
    .map((char) =>
      chars.includes(char) ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}` : char,
    )
    .join("");

describe("findCanaries on JSON escapes", () => {
  it.each([
    ["email", "a \\u002b escape", "+"],
    ["email", "a \\u0040 escape", "@"],
    ["password", "a \\u0021 escape", "!"],
    ["aws_key", "escaped leading letters", "AK"],
  ] as const)("finds the %s with %s", (type, _label, chars) => {
    expect(findCanaries(`"body": "${jsonEscape(valueOf(type), chars)}"`, RUN)).toEqual(only(type));
  });

  it("finds an email whose \\u0040 escape was JSON-escaped again", () => {
    const twice = JSON.stringify(jsonEscape(valueOf("email"), "@"));
    expect(findCanaries(twice, RUN)).toEqual(only("email"));
  });

  it('decodes \\/ and \\" escapes', () => {
    const email = valueOf("email");
    expect(findCanaries(`\\"to\\": \\"${email}\\" \\/x`, RUN)).toEqual(only("email"));
  });
});

describe("findCanaries on digits after unrelated digits", () => {
  it.each([
    ["the card after an order number", "card", `order 1234 ${valueOf("card")}`],
    ["the SSN after a zip code", "ssn", `zip 12345 ${valueOf("ssn")}`],
    ["the phone after a count", "phone", `3 calls ${valueOf("phone")}`],
  ] as const)("finds %s when URL-encoded", (_label, type, text) => {
    expect(findCanaries(encodeURIComponent(text), RUN)).toEqual(only(type));
  });
});

describe("findCanaries with wider digit separators", () => {
  const groups = ["4111", "1111", "1111", "1111"];

  it.each([
    ["commas", ","],
    ["slashes", "/"],
    ["underscores", "_"],
    ["zero-width spaces", "​"],
    ["zero-width joiners", "‍"],
    ["word joiners", "⁠"],
    ["BOMs", "﻿"],
    ["narrow NBSPs", " "],
  ])("finds the card with %s", (_label, separator) => {
    expect(findCanaries(`card ${groups.join(separator)}.`, RUN)).toEqual(only("card"));
  });

  it.each([
    ["a bracketed group", "+61 (491) 570 156"],
    ["a (0) trunk prefix", "+61 (0)491 570 156"],
    ["a bracketed national prefix", "(0491) 570 156"],
  ])("finds the phone with %s", (_label, phone) => {
    expect(findCanaries(`call ${phone} today`, RUN)).toEqual(only("phone"));
  });

  it("finds the SSN with slashes", () => {
    expect(findCanaries(`SSN ${["078", "05", "1120"].join("/")}.`, RUN)).toEqual(only("ssn"));
  });
});

describe("findCanaries on looser HTML entities", () => {
  // Triple URL-encoding is out of scope: it is not guaranteed to be decoded.
  it.each([
    ["a numeric entity without its semicolon", "email", (v: string) => v.replace("@", "&#64")],
    ["&commat;", "email", (v: string) => v.replace("@", "&commat;")],
    ["&plus;", "email", (v: string) => v.replace("+", "&plus;")],
    ["&period;", "ipv4", (v: string) => v.replaceAll(".", "&period;")],
    ["a double-escaped &amp;#x40;", "email", (v: string) => v.replace("@", "&amp;#x40;")],
    ["a double-escaped &amp;commat;", "email", (v: string) => v.replace("@", "&amp;commat;")],
  ] as const)("finds the value with %s", (_label, type, encode) => {
    expect(findCanaries(`x ${encode(valueOf(type))} y`, RUN)).toEqual(only(type));
  });
});

describe("canaries-encodings.test.ts", () => {
  it("holds no canary value as a literal", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    for (const { value } of buildCanaries(RUN)) {
      expect(source).not.toContain(value);
      expect(source).not.toContain(value.replaceAll(" ", ""));
    }
  });
});
