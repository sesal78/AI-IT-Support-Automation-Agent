import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redact } from "./index.js";
import { redactLegacy } from "./redact.js";

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
  // Reviewer failure report (retry 1): cards next to other digits.
  "card 4111 1111 1111 1111 12/28",
  "4111 1111 1111 1111 123",
  "cards 4111111111111111 5555555555554444",
  "4111111111111111 10.0.0.1",
  "4111 1111 1111 1111 123-45-6789",
  "call 415 555 0132 today",
];

// Sensitive items for the pairwise property tests. Every one must be redacted
// wherever it appears next to any other item.
const sensitive: string[] = [
  "jo@x.com",
  "+61 412 345 678",
  "0412 345 678",
  "(02) 9876 5432",
  "1800 123 456",
  "(555) 555-0199",
  "555-555-0123",
  "1-800-555-0199",
  "415 555 0132",
  "123-45-6789",
  "4111 1111 1111 1111",
  "4111-1111-1111-1111",
  "4111111111111111",
  "5555555555554444",
  "3782 822463 10005",
  "192.0.2.10",
  "10.0.0.1",
  "123 456 782",
  "123456782",
  kv("password", ": ", "hunter2"),
];

// Non-sensitive neighbours that sit next to sensitive items in real tickets.
const benign: string[] = [
  "123",
  "12/28",
  "INC0012345",
  "2026-09-28",
  "1.2.3",
  "4111 1111 1111 1112",
  "123 456 789",
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

  it("redacts cards followed by an expiry, a CVV or another card", () => {
    expect(redact("card 4111 1111 1111 1111 12/28")).toEqual({
      text: "card [REDACTED_CARD] 12/28",
      log: [{ type: "CARD", count: 1 }],
    });
    expect(redact("4111 1111 1111 1111 123")).toEqual({
      text: "[REDACTED_CARD] 123",
      log: [{ type: "CARD", count: 1 }],
    });
    expect(redact("cards 4111111111111111 5555555555554444")).toEqual({
      text: "cards [REDACTED_CARD] [REDACTED_CARD]",
      log: [{ type: "CARD", count: 2 }],
    });
  });

  it("redacts a card and a following IPv4 or SSN in a single pass", () => {
    expect(redact("4111111111111111 10.0.0.1")).toEqual({
      text: "[REDACTED_CARD] [REDACTED_IPV4]",
      log: [
        { type: "CARD", count: 1 },
        { type: "IPV4", count: 1 },
      ],
    });
    expect(redact("4111 1111 1111 1111 123-45-6789")).toEqual({
      text: "[REDACTED_CARD] [REDACTED_SSN]",
      log: [
        { type: "CARD", count: 1 },
        { type: "SSN", count: 1 },
      ],
    });
  });

  it("redacts a US phone number written with spaces", () => {
    expect(redact("call 415 555 0132 today")).toEqual({
      text: "call [REDACTED_PHONE] today",
      log: [{ type: "PHONE", count: 1 }],
    });
  });

  it("is idempotent over every space-separated pair of items", () => {
    const all = [...sensitive, ...benign];
    for (const a of all) {
      for (const b of all) {
        const input = `${a} ${b}`;
        const once = redact(input).text;
        expect(redact(once).text, input).toBe(once);
      }
    }
  });

  it("redacts both items of every space-separated sensitive pair", () => {
    for (const a of sensitive) {
      for (const b of [...sensitive, ...benign]) {
        for (const input of [`${a} ${b}`, `${b} ${a}`]) {
          const out = redact(input).text;
          expect(out, input).not.toContain(a);
          if (sensitive.includes(b)) expect(out, input).not.toContain(b);
        }
      }
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

// Key fixtures, built from pieces at run time so no key-shaped literal is in
// this file (the scan test below enforces that).
const card16 = "4111111111111111";
const awsKey = "AK" + "IA" + "X7Q2".repeat(4);
const ghToken = "gh" + "p_" + "ab12CD".repeat(6);
// The same two shapes with a Luhn-valid 16-digit run inside.
const keys = [
  awsKey,
  ghToken,
  "AK" + "IA" + card16,
  "gh" + "p_" + "ab12CD".repeat(3) + card16 + "xy",
];
const KEY_TYPES = ["AWS_KEY", "GITHUB_TOKEN"];
const keyNearMisses = [
  "AK" + "IA" + "X7Q2X7Q2",
  "Z" + awsKey,
  awsKey.toLowerCase(),
  "gh" + "p_" + "a".repeat(10),
];

describe("redact: fixed-length key patterns", () => {
  it("redacts a bare AWS access key with a per-type log", () => {
    expect(redact("key " + awsKey)).toEqual({
      text: "key [REDACTED_AWS_KEY]",
      log: [{ type: "AWS_KEY", count: 1 }],
    });
  });

  it("redacts a GitHub token", () => {
    expect(redact(`(${ghToken})`)).toEqual({
      text: "([REDACTED_GITHUB_TOKEN])",
      log: [{ type: "GITHUB_TOKEN", count: 1 }],
    });
  });

  it("leaves near-misses unchanged", () => {
    for (const input of keyNearMisses) {
      expect(redact(input), input).toEqual({ text: input, log: [] });
    }
  });

  it("replaces a key that holds a Luhn-valid digit run with one placeholder", () => {
    expect(redact(keys[2]!)).toEqual({
      text: "[REDACTED_AWS_KEY]",
      log: [{ type: "AWS_KEY", count: 1 }],
    });
    expect(redact(keys[3]!)).toEqual({
      text: "[REDACTED_GITHUB_TOKEN]",
      log: [{ type: "GITHUB_TOKEN", count: 1 }],
    });
  });

  it("redacts both a key and a card joined to it by a dash", () => {
    expect(redact(`${awsKey}-4111 1111 1111 1111`).text).toBe("[REDACTED_AWS_KEY]-[REDACTED_CARD]");
  });

  it("logs types and counts only, never a matched value", () => {
    const out = redact(keys.join(" "));
    expect(out.log).toEqual([
      { type: "AWS_KEY", count: 2 },
      { type: "GITHUB_TOKEN", count: 2 },
    ]);
    for (const key of keys) {
      expect(out.text).not.toContain(key);
      expect(JSON.stringify(out.log)).not.toContain(key);
    }
  });

  it("is idempotent over old and new fixtures, alone and in pairs", () => {
    for (const a of [...fixtures, ...keys, ...keyNearMisses]) {
      for (const input of [a, ...keys.flatMap((k) => [`${a} ${k}`, `${k} ${a}`, k + a])]) {
        const once = redact(input).text;
        expect(redact(once).text, input).toBe(once);
      }
    }
  });

  it("has no literal in this file that matches a key rule", () => {
    // `:`, `=` and `@` are blanked so the SECRET and EMAIL rules cannot swallow
    // a key before its own rule sees it.
    const scan = (s: string) =>
      redact(s.replace(/[:=@]/g, " ")).log.filter((e) => KEY_TYPES.includes(e.type));
    expect(scan(`token: "${ghToken}"`)).toEqual([{ type: "GITHUB_TOKEN", count: 1 }]);
    expect(scan(readFileSync(fileURLToPath(import.meta.url), "utf8"))).toEqual([]);
  });

  it("leaves no digit run or @domain that the legacy rules remove (generated)", () => {
    // Fixed-seed Lehmer generator, so the 5 000 inputs are the same every run.
    let seed = 20261004;
    const rnd = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    const pick = (list: string[]) => list[rnd(list.length)]!;
    const pieces = [
      ...keys,
      ...keys.flatMap((k) => [k + "@site7.example", `jo9@${k}.example`]),
      ...sensitive,
      ...benign,
      "ann@corp.example",
      "jo3",
      "host",
      "site7.example",
      kv("token", "=", "x1"),
    ];
    const joins = [
      ".",
      "_",
      "+",
      "-",
      " ",
      ":",
      "/",
      "=",
      '"',
      "'",
      "(",
      ")",
      "[",
      "]",
      "\n",
      "@",
      "",
    ];
    const survivors = (s: string) =>
      s.replace(/\[REDACTED_[A-Z0-9_]+\]/g, "|").match(/\d+|@[\w.-]+/g) ?? [];
    for (let i = 0; i < 5_000; i++) {
      let input = "";
      for (let k = 2 + rnd(5); k > 0; k--) input += pick(pieces) + pick(joins);
      const out = redact(input).text;
      const legacy = survivors(redactLegacy(input).text);
      for (const run of survivors(out)) {
        expect(
          legacy.some((kept) => kept.includes(run)),
          `${input} -> ${out}`,
        ).toBe(true);
      }
      expect(redact(out).text, input).toBe(out);
    }
  });

  it("stays linear on adversarial key-shaped input", () => {
    const seeds = ["AKIA", "AKIA7", "AKIA-", "ghp_", "ghp_a-", awsKey, ghToken, ghToken + " "];
    for (const [size, limit] of [
      [5_000, 250],
      [100_000, 2_000],
    ] as const) {
      const start = performance.now();
      for (const seed of seeds) redact(seed.repeat(Math.ceil(size / seed.length)));
      expect(performance.now() - start, `size ${size}`).toBeLessThan(limit);
    }
  });
});

// Review failure report (part 1, review 3): a `-` in front of a key is not
// part of a word, so the key is still redacted.
describe("redact: key boundaries", () => {
  it("redacts a key directly after a dash", () => {
    const rows: Array<[string, string]> = [
      ["-" + awsKey, "-[REDACTED_AWS_KEY]"],
      ["access-key-" + awsKey, "access-key-[REDACTED_AWS_KEY]"],
      ["prod-" + awsKey + ".csv", "prod-[REDACTED_AWS_KEY].csv"],
      ["--pat-" + ghToken, "--pat-[REDACTED_GITHUB_TOKEN]"],
      ["my-token-" + ghToken, "my-token-[REDACTED_GITHUB_TOKEN]"],
    ];
    for (const [input, expected] of rows) {
      expect(redact(input).text, input).toBe(expected);
      expect(redact(expected).text, input).toBe(expected);
    }
    expect(redact(`-${awsKey}\n-${ghToken}\n`)).toEqual({
      text: "-[REDACTED_AWS_KEY]\n-[REDACTED_GITHUB_TOKEN]\n",
      log: [
        { type: "AWS_KEY", count: 1 },
        { type: "GITHUB_TOKEN", count: 1 },
      ],
    });
  });

  it("leaves a GitHub token with a letter in front or 37 characters unchanged", () => {
    for (const input of ["x" + ghToken, ghToken + "a"]) {
      expect(redact(input), input).toEqual({ text: input, log: [] });
    }
  });

  it("keeps the key rules out of the legacy rule set", () => {
    for (const key of [awsKey, ghToken]) {
      expect(redactLegacy("key " + key)).toEqual({ text: "key " + key, log: [] });
    }
  });

  it("redacts a card and an SSN glued in front of +<key>@domain", () => {
    for (const key of [awsKey, ghToken]) {
      const spaced = `4111 1111 1111 1111 123-45-6789+${key}@site7.example`;
      const glued = `4111111111111111-123-45-6789+${key}@site7.example`;
      for (const fn of [redact, redactLegacy]) {
        expect(fn(spaced)).toEqual({
          text: "[REDACTED_CARD] [REDACTED_EMAIL]",
          log: [
            { type: "EMAIL", count: 1 },
            { type: "CARD", count: 1 },
          ],
        });
        expect(fn(glued)).toEqual({
          text: "[REDACTED_EMAIL]",
          log: [{ type: "EMAIL", count: 1 }],
        });
      }
    }
  });
});

// Found by the differential fuzz (part 1, retry 3): an email whose last label
// is `ghp` takes the token prefix (`jo@x.ghp` then `_<body>`) before the
// GitHub rule runs. The body left behind is still redacted.
describe("redact: a GitHub token whose prefix an email took", () => {
  it("redacts the token body left after the email placeholder", () => {
    for (const input of [`ann@corp.example.${ghToken}`, `jo@x.com${ghToken} end`]) {
      const out = redact(input);
      expect(out.text, input).toMatch(/^\[REDACTED_EMAIL\]\[REDACTED_GITHUB_TOKEN\]( end)?$/);
      expect(out.log, input).toEqual([
        { type: "EMAIL", count: 1 },
        { type: "GITHUB_TOKEN", count: 1 },
      ]);
      expect(redact(out.text).text, input).toBe(out.text);
    }
    expect(redact("ann@corp.example_ab12").text).toBe("[REDACTED_EMAIL]_ab12");
  });

  it("stays linear on repeated email and token-body fragments", () => {
    for (const size of [5_000, 100_000]) {
      const start = performance.now();
      for (const unit of ["jo@x.ghp_" + "a1".repeat(18), "[REDACTED_EMAIL]_", "jo@x.ghp_a"]) {
        redact(unit.repeat(Math.ceil(size / unit.length)));
      }
      expect(performance.now() - start, `size ${size}`).toBeLessThan(2_000);
    }
  });
});

// Review finding (part 1, both reviews): keys glued with no separator survived
// whole. Each key in such a run is redacted; a run of key characters that is
// not a whole key stays a near-miss.
describe("redact: glued keys", () => {
  const A = "[REDACTED_AWS_KEY]";
  const G = "[REDACTED_GITHUB_TOKEN]";
  const log = (aws: number, gh: number) => [
    ...(aws ? [{ type: "AWS_KEY", count: aws }] : []),
    ...(gh ? [{ type: "GITHUB_TOKEN", count: gh }] : []),
  ];

  it("redacts every key in a glued run", () => {
    const rows: Array<[string, string, number, number]> = [
      [awsKey + awsKey, A + A, 2, 0],
      [ghToken + ghToken, G + G, 0, 2],
      [awsKey + ghToken, A + G, 1, 1],
      [ghToken + awsKey, G + A, 1, 1],
      [`key ${awsKey}${ghToken}${awsKey}.`, `key ${A}${G}${A}.`, 2, 1],
      [`(${ghToken}${awsKey}${ghToken})`, `(${G}${A}${G})`, 1, 2],
      [keys.join(""), A + G + A + G, 2, 2],
      ["-" + awsKey.repeat(3), "-" + A + A + A, 3, 0],
      [`ann@corp.example.${ghToken}${ghToken}`, `[REDACTED_EMAIL]${G}${G}`, 0, 2],
    ];
    for (const [input, text, aws, gh] of rows) {
      const out = redact(input);
      expect(out.text, input).toBe(text);
      expect(
        out.log.filter((e) => KEY_TYPES.includes(e.type)),
        input,
      ).toEqual(log(aws, gh));
      expect(redact(text).text, input).toBe(text);
    }
  });

  it("keeps a too-long tail a near-miss unless a whole key starts there", () => {
    const rows: Array<[string, string]> = [
      [awsKey + "Z", awsKey + "Z"],
      [awsKey + awsKey + "Z", A + awsKey + "Z"],
      [ghToken + ghToken + "a", G + ghToken + "a"],
      [awsKey + awsKey.slice(0, 19), awsKey + awsKey.slice(0, 19)],
      [ghToken + "AK" + "IA" + "X7Q2", ghToken + "AK" + "IA" + "X7Q2"],
      // Rule: a glued run that starts after a word character is a near-miss
      // as a whole (same as dev). Changed in P3-T3a1b review 1.
      ["Z" + awsKey + awsKey, "Z" + awsKey + awsKey],
    ];
    for (const [input, text] of rows) {
      expect(redact(input).text, input).toBe(text);
      expect(redact(text).text, input).toBe(text);
    }
  });

  it("stays linear on glued key runs", () => {
    const units = [awsKey + ghToken, ghToken + awsKey, awsKey + awsKey, ghToken + ghToken];
    for (const size of [5_000, 100_000]) {
      for (const unit of [...units, ...units.map((u) => u + "Z"), "a" + ghToken]) {
        const input = unit.repeat(Math.ceil(size / unit.length));
        const start = performance.now();
        redact(input);
        expect(performance.now() - start, `${size} ${unit.length}`).toBeLessThan(2_000);
      }
    }
  });
});

// Review failure report (P3-T3a1b, review 1): a key-shaped window inside a
// token body counted as "a whole key in front", so a glued run was split in
// the wrong place and parts of two keys leaked.
describe("redact: glued runs split from their start", () => {
  const P = "AK" + "IA";
  const H = "gh" + "p_";
  const ghSeeded = H + P.repeat(9); // AKIA at every body offset 0, 4, ..., 32
  const ghMixed = H + P + "Q7".repeat(8) + P + "9".repeat(12); // AKIA at 0 and 20
  const ghDigits = H + "1234567890".repeat(3) + "123456";
  const awsSeeded = P + P.repeat(4);
  const awsDigits = P + "1234567890123456";
  const A = "[REDACTED_AWS_KEY]";
  const G = "[REDACTED_GITHUB_TOKEN]";
  const n = (s: string, p: string) => s.split(p).length - 1;

  it("redacts every whole key in a glued run, whatever its body", () => {
    const rows: Array<[string, string]> = [
      [H + P.repeat(19), G + A + A],
      [`ann@corp.example.${ghMixed}${awsSeeded}${awsSeeded}`, `[REDACTED_EMAIL]${G}${A}${A}`],
      [`ann@corp.example.${ghSeeded}${awsDigits}`, `[REDACTED_EMAIL]${G}${A}`],
      [awsSeeded + ghSeeded + awsSeeded, A + G + A],
      [awsSeeded + ghMixed + ghSeeded, A + G + G],
      [`(${ghMixed}${awsDigits}${ghDigits})`, `(${G}${A}${G})`],
      [awsDigits + ghSeeded + "_x", A + G + "_x"],
      ["id-" + ghSeeded + awsSeeded, "id-" + G + A],
      // Review 2: AKIA at token body offsets 0 and 20, then K3 and K4.
      [
        ` ${H}${P}${"Q7".repeat(8)}${P}${"9".repeat(12)}${P}${P}${"8".repeat(12)}${P}${"X".repeat(16)} `,
        ` ${G}${A}${A} `,
      ],
      [`ann@corp.example.${ghMixed}${P}${P}${"8".repeat(12)}`, `[REDACTED_EMAIL]${G}${A}`],
      [awsDigits + ghMixed + P + P + "8".repeat(12), A + G + A],
      ["[REDACTED_CARD]" + ghMixed + awsDigits + ".", "[REDACTED_CARD]" + G + A + "."],
    ];
    for (const [input, text] of rows) {
      const out = redact(input);
      expect(out.text, input).toBe(text);
      const keyLog = out.log.filter((e) => KEY_TYPES.includes(e.type));
      expect(keyLog, input).toEqual([
        { type: "AWS_KEY", count: n(text, A) },
        { type: "GITHUB_TOKEN", count: n(text, G) },
      ]);
      expect(redact(text).text, input).toBe(text);
    }
  });

  it("leaves seeded near-misses unchanged", () => {
    for (const input of [
      ghSeeded + "A",
      ghSeeded + P + "1".repeat(15),
      awsSeeded + P.repeat(4),
      "Z" + ghSeeded + awsSeeded,
      H + P.repeat(8) + "AKI",
    ]) {
      expect(redact(input), input).toEqual({ text: input, log: [] });
    }
  });

  it("stays linear on seeded glued runs", () => {
    const units = [ghSeeded + awsSeeded, awsSeeded + ghMixed, H + P.repeat(19) + "Z", P, H + P];
    for (const size of [5_000, 100_000]) {
      const start = performance.now();
      for (const unit of units) redact(unit.repeat(Math.ceil(size / unit.length)));
      expect(performance.now() - start, `size ${size}`).toBeLessThan(2_000);
    }
  });
});

// P3-T3a2: `sk-` keys and Slack tokens. Both are open-ended: a key runs to the
// end of its word-and-dash run. Built from pieces so no literal matches.
const SKP = "s" + "k-";
const skKey = SKP + "aB3d".repeat(5);
const slackKey = (c: string) => "xo" + "x" + c + "-" + "12ab".repeat(5);
const AK = "[REDACTED_API_KEY]";
const SL = "[REDACTED_SLACK_TOKEN]";
const NEW_TYPES = ["API_KEY", "SLACK_TOKEN"];
const openKeys = [skKey, slackKey("a"), slackKey("b"), slackKey("p")];
const strip = (s: string) => s.replace(/\[REDACTED_[A-Z0-9_]+\]/g, "|");

describe("redact: sk- keys and Slack tokens", () => {
  it("redacts an sk- key and each Slack prefix with a per-type log", () => {
    expect(redact("key " + skKey)).toEqual({
      text: "key " + AK,
      log: [{ type: "API_KEY", count: 1 }],
    });
    for (const c of ["a", "b", "p"]) {
      expect(redact(`(${slackKey(c)})`)).toEqual({
        text: `(${SL})`,
        log: [{ type: "SLACK_TOKEN", count: 1 }],
      });
    }
  });

  it("leaves near-misses unchanged", () => {
    for (const input of [
      SKP + "1234",
      "risk-assessment-document-final",
      "task-force-alpha-bravo-charlie",
      SKP + "a".repeat(15),
      "x" + skKey,
      "_" + skKey,
      skKey.toUpperCase(),
      slackKey("z"),
      "xo" + "xb-short",
      "xo" + "xb-" + "a".repeat(9),
      "x" + slackKey("b"),
      "xo" + "xb-ab_" + "c".repeat(20),
      ghToken + SKP + "1234",
    ]) {
      expect(redact(input), input).toEqual({ text: input, log: [] });
    }
  });

  it("redacts a key after a dash, punctuation, the start or any placeholder", () => {
    const types = ["SECRET", "EMAIL", "AWS_KEY", "API_KEY", "GITHUB_TOKEN", "SLACK_TOKEN"];
    const fronts = ["", "-", "--", "prod-", "(", ".", "/", " ", "\n", '"', "'", "#"];
    for (const t of [...types, "CARD", "SSN", "IPV4", "PHONE", "AU_TFN"]) {
      fronts.push(`[REDACTED_${t}]`);
    }
    for (const front of fronts) {
      for (const [key, ph] of [
        [skKey, AK],
        [slackKey("b"), SL],
      ] as const) {
        for (const back of ["", ".", " end", ")"]) {
          const input = front + key + back;
          expect(redact(input).text, input).toBe(front + ph + back);
        }
      }
    }
  });

  it("replaces a key holding a Luhn-valid digit run with one placeholder", () => {
    const rows: Array<[string, string]> = [
      [SKP + card16, AK],
      [`${SKP}abcd-${card16}.`, AK + "."],
      [`${slackKey("b")}-${card16}-abcd 5`, SL + " 5"],
      [`${SKP}front-desk-line-77-0412 345 678 x`, AK + " x"],
      [`${SKP}abcdefgh-77-4111 1111 1111 1111`, AK],
      [`${slackKey("a")}-7-415.555.0100`, SL],
    ];
    for (const [input, text] of rows) {
      const out = redact(input);
      expect(out.text, input).toBe(text);
      expect(out.log.filter((e) => NEW_TYPES.includes(e.type)).length, input).toBe(1);
    }
  });

  it("redacts keys glued to each other and to AWS and GitHub keys", () => {
    const A = "[REDACTED_AWS_KEY]";
    const G = "[REDACTED_GITHUB_TOKEN]";
    const rows: Array<[string, string]> = [
      [skKey + skKey, AK],
      [skKey + awsKey + ghToken, AK],
      [slackKey("p") + "-" + ghToken, SL],
      [awsKey + skKey, A + AK],
      [ghToken + skKey, G + AK],
      [ghToken + slackKey("b"), G + SL],
      [awsKey + ghToken + slackKey("a") + "." + skKey, A + G + SL + "." + AK],
      [awsKey + "-" + slackKey("a"), A + "-" + SL],
    ];
    for (const [input, text] of rows) {
      expect(redact(input).text, input).toBe(text);
      expect(redact(text).text, input).toBe(text);
    }
  });

  it("redacts keys glued to other sensitive items in both orders", () => {
    for (const key of openKeys) {
      for (const item of [...sensitive, kv("token", "=", "x1")]) {
        for (const join of ["-", " ", "."]) {
          for (const input of [item + join + key, key + join + item]) {
            const out = strip(redact(input).text);
            expect(out, input).not.toMatch(/\d|sk-|xox/);
          }
        }
      }
    }
  });

  it("logs types and counts only, never a matched value", () => {
    const out = redact(openKeys.join(" ") + " " + skKey);
    expect(out.log).toEqual([
      { type: "API_KEY", count: 2 },
      { type: "SLACK_TOKEN", count: 3 },
    ]);
    for (const key of openKeys) expect(JSON.stringify(out)).not.toContain(key);
  });

  it("keeps the new rules out of the legacy rule set", () => {
    for (const key of openKeys) {
      expect(redactLegacy("key " + key)).toEqual({ text: "key " + key, log: [] });
    }
  });

  it("is idempotent over old and new fixtures, alone and in pairs", () => {
    for (const a of [...fixtures, ...keys, ...openKeys]) {
      for (const input of [
        a,
        ...openKeys.flatMap((k) => [`${a} ${k}`, k + a, a + k, `${a}-${k}`]),
      ]) {
        const once = redact(input).text;
        expect(redact(once).text, input).toBe(once);
      }
    }
  });

  it("has no literal in this file that matches a new rule", () => {
    const scan = (s: string) =>
      redact(s.replace(/[:=@]/g, " ")).log.filter((e) => NEW_TYPES.includes(e.type));
    expect(scan(`token: "${skKey}"`)).toEqual([{ type: "API_KEY", count: 1 }]);
    expect(scan(readFileSync(fileURLToPath(import.meta.url), "utf8"))).toEqual([]);
  });

  it("stays linear on long and repeated key-shaped input", () => {
    const units = [
      SKP,
      "xo" + "xb-",
      "-",
      SKP + "1-",
      SKP + "a-1 ",
      "-" + SKP + "a_",
      ghToken + SKP,
    ];
    for (const [size, limit] of [
      [5_000, 500],
      [100_000, 2_000],
    ] as const) {
      const inputs = units.map((u) => u.repeat(Math.ceil(size / u.length)));
      inputs.push(SKP + "a".repeat(size * 2), SKP + "a-1" + " 1".repeat(size));
      for (const input of inputs) {
        const start = performance.now();
        redact(input);
        expect(performance.now() - start, `${size} ${input.slice(0, 8)}`).toBeLessThan(limit);
      }
    }
  });
});
