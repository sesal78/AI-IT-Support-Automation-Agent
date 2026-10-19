import { describe, expect, it } from "vitest";
import { buildKbQuery, KB_QUERY_MAX_WORDS } from "./kb-query.js";

const WORD = "[a-z0-9]+(?:[-.][a-z0-9]+)*";
const SAFE = new RegExp(`^${WORD}( or ${WORD})*$`);

describe("buildKbQuery", () => {
  it("builds an or query from the content words", () => {
    expect(buildKbQuery("My VPN will not connect from home")).toBe("vpn or connect or home");
  });

  it("removes [REDACTED_*] placeholders", () => {
    expect(buildKbQuery("call [REDACTED_PHONE] about the printer")).toBe("call or printer");
  });

  it("treats a lower-case placeholder like an upper-case one and splits glued words", () => {
    expect(buildKbQuery("call [redacted_phone] printer")).toBe("call or printer");
    expect(buildKbQuery("foo[REDACTED_EMAIL]bar")).toBe("foo or bar");
    expect(buildKbQuery("[REDACTED_[REDACTED_SSN]]")).toBe("");
  });

  it.each(["", "the and of it is", "!!! ??? ...", "   \t\n ", "a b c ab 12"])(
    "returns an empty string for %j",
    (text) => {
      expect(buildKbQuery(text)).toBe("");
    },
  );

  it("removes duplicates and keeps the first occurrence", () => {
    expect(buildKbQuery("Printer printer PRINTER jam printer")).toBe("printer or jam");
  });

  it.each([
    ["Wi-Fi keeps dropping", "wi-fi or wifi or keeps or dropping"],
    ["my e-mail is broken", "e-mail or email or mail or broken"],
    ["cannot log-in today", "log-in or login or log or today"],
    ["card on 802.11 network", "card or 802.11 or 80211 or 802 or network"],
  ])("keeps the hyphenated or dotted term in %j", (text, expected) => {
    expect(buildKbQuery(text)).toBe(expected);
  });

  it("does not join words across a sentence-ending dot or a spaced hyphen", () => {
    expect(buildKbQuery("restart. then retry")).toBe("restart or retry");
    expect(buildKbQuery("vpn - down -- router")).toBe("vpn or down or router");
  });

  it("handles URL and path-like tokens (a joined form over 15 characters is dropped)", () => {
    expect(buildKbQuery("see https://portal.example.com/vpn-help now")).toBe(
      "see or https or portal or example or com or vpn-help or vpnhelp or vpn or help",
    );
  });

  it("drops a joined or hyphenated form over 15 characters but keeps its parts", () => {
    expect(buildKbQuery("printer-configuration")).toBe("printer or configuration");
  });

  it("keeps digit-only words of length 3 or more", () => {
    expect(buildKbQuery("error 404 and 42")).toBe("error or 404");
  });

  it("keeps at most 20 words and 400 characters on a 5000 character text", () => {
    const text = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
    const out = buildKbQuery(text.slice(0, 5000));
    expect(out.split(" or ")).toHaveLength(KB_QUERY_MAX_WORDS);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.startsWith("word0 or word1 or ")).toBe(true);
  });

  it("holds 400 characters with the longest allowed words", () => {
    const text = Array.from({ length: 40 }, (_, i) => `${"x".repeat(14)}${i % 10}${i}`).join(" ");
    expect(buildKbQuery(text).length).toBeLessThanOrEqual(400);
  });

  it("drops a very long single word instead of cutting it", () => {
    expect(buildKbQuery(`${"a".repeat(10_000)} vpn`)).toBe("vpn");
  });

  it("strips accents and drops letters outside a-z", () => {
    expect(buildKbQuery("Café naïve résumé")).toBe("cafe or naive or resume");
    expect(buildKbQuery("привет vpn 你好 emoji😀printer")).toBe("vpn or emoji or printer");
  });

  it("splits on tabs and newlines", () => {
    expect(buildKbQuery("vpn\tdown\nlaptop\r\nrouter")).toBe("vpn or down or laptop or router");
  });

  const attacks = [
    `"vpn" -wifi (router) OR laptop AND mouse`,
    `vpn:* & wifi | !router <-> dock`,
    `'; drop table x; --`,
    `a'b"c-d(e)f[g]h{i}j\\k/l%m_n`,
    `[[[[[[ ]]]]]] ((((( ))))) """"" ----- vpn`,
    `foo[REDACTED_EMAIL]bar [redacted_x] [REDACTED_] [REDACTED_A B]`,
  ];
  it.each(attacks)("returns only a-z0-9 words joined by or for %j", (text) => {
    const out = buildKbQuery(text);
    if (out !== "") expect(out).toMatch(SAFE);
    expect(out).not.toMatch(/[^a-z0-9 .-]|(^|[ ])[-.]|[-.]($|[ ])|[-.][-.]/);
  });

  it("never lets a user word act as an operator", () => {
    const words = buildKbQuery(`vpn OR or AND not wifi`).split(" or ");
    expect(words).toEqual(["vpn", "wifi"]);
  });

  it.each([undefined, null, 42, {}, ["vpn"], Symbol("x"), 1n])(
    "throws a TypeError for the non-string %s",
    (value) => {
      expect(() => buildKbQuery(value as never)).toThrow(TypeError);
    },
  );

  it("is linear: 1 MB of input takes well under a second", () => {
    for (const unit of ["a ", "[redacted_", "é", "!!", "the ", "x".repeat(50) + " "]) {
      const text = unit.repeat(Math.ceil(1_000_000 / unit.length));
      const start = performance.now();
      buildKbQuery(text);
      expect(performance.now() - start).toBeLessThan(500);
    }
  });
});
