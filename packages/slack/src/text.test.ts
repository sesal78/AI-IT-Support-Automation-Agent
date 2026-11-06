import { describe, expect, it } from "vitest";
import { escapeMrkdwn, truncate } from "./text.js";

describe("escapeMrkdwn", () => {
  it.each([
    ["<!channel>", "&lt;!channel&gt;"],
    ["<!here>", "&lt;!here&gt;"],
    ["<@U123>", "&lt;@U123&gt;"],
    ["<#C123>", "&lt;#C123&gt;"],
    ["<https://evil.example|click>", "&lt;https://evil.example|click&gt;"],
    ["a & b", "a &amp; b"],
    ["&lt;", "&amp;lt;"],
    ["&amp;", "&amp;amp;"],
    ["", ""],
    ["plain text", "plain text"],
  ])("escapes %j", (input, expected) => {
    expect(escapeMrkdwn(input)).toBe(expected);
  });

  it("handles markers at the start, the end and repeated", () => {
    expect(escapeMrkdwn("<a")).toBe("&lt;a");
    expect(escapeMrkdwn("a>")).toBe("a&gt;");
    expect(escapeMrkdwn("&a")).toBe("&amp;a");
    expect(escapeMrkdwn("a&")).toBe("a&amp;");
    expect(escapeMrkdwn("<<>>&&")).toBe("&lt;&lt;&gt;&gt;&amp;&amp;");
  });

  it("never leaves a raw angle bracket", () => {
    expect(escapeMrkdwn("<<!channel>> <@U1> <http://x|y>")).not.toMatch(/[<>]/);
  });

  it.each([undefined, null, 1, {}, ["a"]])("throws TypeError for non-string %j", (input) => {
    expect(() => escapeMrkdwn(input as unknown as string)).toThrow(TypeError);
  });
});

describe("truncate", () => {
  it("cuts a 3000-character title to 150 code points ending with an ellipsis", () => {
    const out = truncate("a".repeat(3000), 150);
    expect([...out]).toHaveLength(150);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves a title that fits unchanged", () => {
    const title = "b".repeat(150);
    expect(truncate(title, 150)).toBe(title);
    expect(truncate("", 150)).toBe("");
  });

  it("cuts on a code point boundary", () => {
    const out = truncate("😀".repeat(10), 4);
    expect(out).toBe("😀😀😀…");
    expect([...out]).toHaveLength(4);
  });

  it("counts code points, not UTF-16 units, when deciding that text fits", () => {
    expect(truncate("😀".repeat(5), 5)).toBe("😀".repeat(5));
  });

  it("gives only the ellipsis when max is 1 and the text is longer", () => {
    expect(truncate("abc", 1)).toBe("…");
    expect(truncate("a", 1)).toBe("a");
    expect(truncate("", 1)).toBe("");
  });

  it("may split a ZWJ sequence between code points (code points only, by design)", () => {
    const family = "👨‍👩‍👧"; // man ZWJ woman ZWJ girl: 5 code points
    expect([...family]).toHaveLength(5);
    expect(truncate(family, 5)).toBe(family);
    expect(truncate(family, 3)).toBe("👨\u200D…");
  });

  it.each([0, -1, Number.NaN, 1.5, Infinity, -Infinity])("throws RangeError for max %s", (max) => {
    expect(() => truncate("abc", max)).toThrow(RangeError);
  });

  it("throws TypeError for non-string text and RangeError for non-number max", () => {
    expect(() => truncate(1 as unknown as string, 5)).toThrow(TypeError);
    expect(() => truncate("a", "5" as unknown as number)).toThrow(RangeError);
  });
});
