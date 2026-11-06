import { describe, expect, it } from "vitest";
import { validateMessage, type SlackBlock, type SlackMessage } from "./limits.js";

const pt = (text: string) => ({ type: "plain_text", text });
const mk = (text: string) => ({ type: "mrkdwn", text });
const x = (n: number) => "x".repeat(n);

const button = (over: Record<string, unknown> = {}) => ({
  type: "button",
  text: pt("ok"),
  value: "v",
  action_id: "a1",
  ...over,
});

const section = (over: Record<string, unknown> = {}): SlackBlock => ({
  type: "section",
  block_id: "s1",
  text: mk("hi"),
  ...over,
});

const actions = (el: Record<string, unknown>): SlackMessage => ({
  text: "t",
  blocks: [{ type: "actions", block_id: "a", elements: [el] }],
});

const one = (block: SlackBlock): SlackMessage => ({ text: "t", blocks: [block] });

const many = (n: number): SlackMessage => ({
  text: "t",
  blocks: Array.from({ length: n }, (_, i) => section({ block_id: `b${i}` })),
});

const cases: Array<{ rule: string; atLimit: SlackMessage; overLimit: SlackMessage }> = [
  { rule: "blocks.max", atLimit: many(50), overLimit: many(51) },
  {
    rule: "header.text.max",
    atLimit: one({ type: "header", block_id: "h", text: pt(x(150)) }),
    overLimit: one({ type: "header", block_id: "h", text: pt(x(151)) }),
  },
  {
    rule: "section.text.max",
    atLimit: one(section({ text: mk(x(3000)) })),
    overLimit: one(section({ text: mk(x(3001)) })),
  },
  {
    rule: "section.fields.max",
    atLimit: one(section({ fields: Array.from({ length: 10 }, () => mk("f")) })),
    overLimit: one(section({ fields: Array.from({ length: 11 }, () => mk("f")) })),
  },
  {
    rule: "section.field.text.max",
    atLimit: one(section({ fields: [mk(x(2000))] })),
    overLimit: one(section({ fields: [mk(x(2001))] })),
  },
  {
    rule: "button.text.max",
    atLimit: actions(button({ text: pt(x(75)) })),
    overLimit: actions(button({ text: pt(x(76)) })),
  },
  {
    rule: "button.value.max",
    atLimit: actions(button({ value: x(2000) })),
    overLimit: actions(button({ value: x(2001) })),
  },
  {
    rule: "action_id.max",
    atLimit: actions(button({ action_id: x(255) })),
    overLimit: actions(button({ action_id: x(256) })),
  },
  {
    rule: "block_id.unique",
    atLimit: { text: "t", blocks: [section({ block_id: "a" }), section({ block_id: "b" })] },
    overLimit: { text: "t", blocks: [section({ block_id: "a" }), section({ block_id: "a" })] },
  },
  {
    rule: "text.max",
    atLimit: { text: x(3000), blocks: [] },
    overLimit: { text: x(3001), blocks: [] },
  },
];

describe("validateMessage", () => {
  it.each(cases)("$rule: passes at the limit", ({ atLimit }) => {
    expect(validateMessage(atLimit)).toEqual([]);
  });

  it.each(cases)("$rule: one violation at limit + 1", ({ rule, overLimit }) => {
    const found = validateMessage(overLimit);
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe(rule);
  });

  it("reports the location of a violation", () => {
    const [v] = validateMessage(one(section({ text: mk(x(3001)) })));
    expect(v?.path).toBe("blocks[0].text");
    expect(v?.limit).toBe(3000);
    expect(v?.actual).toBe(3001);
  });

  it("checks a section accessory button", () => {
    const found = validateMessage(one(section({ accessory: button({ value: x(2001) }) })));
    expect(found.map((v) => v.rule)).toEqual(["button.value.max"]);
  });

  it("reports a duplicated block_id once, however many times it repeats", () => {
    const blocks = [1, 2, 3].map(() => section({ block_id: "dup" }));
    expect(validateMessage({ text: "t", blocks }).map((v) => v.rule)).toEqual(["block_id.unique"]);
  });

  it("counts code points, not UTF-16 units", () => {
    const m = one({ type: "header", block_id: "h", text: pt("😀".repeat(150)) });
    expect(validateMessage(m)).toEqual([]);
  });

  it("accepts missing optional parts", () => {
    expect(validateMessage({})).toEqual([]);
    expect(validateMessage({ text: "t" })).toEqual([]);
    expect(validateMessage({ blocks: [] })).toEqual([]);
    expect(
      validateMessage({
        blocks: [
          { type: "section" },
          { type: "header" },
          { type: "actions" },
          { type: "actions", elements: [{ type: "button" }] },
          { type: "section", fields: [] },
        ],
      }),
    ).toEqual([]);
  });

  it("leaves block types it does not know alone, but still counts them", () => {
    const odd: SlackBlock = { type: "divider", text: pt(x(9999)) };
    expect(validateMessage({ blocks: [odd, odd] })).toEqual([]);
    const fifty1 = Array.from({ length: 51 }, () => ({ type: "divider" }));
    expect(validateMessage({ blocks: fifty1 }).map((v) => v.rule)).toEqual(["blocks.max"]);
    const dup = [
      { type: "divider", block_id: "d" },
      { type: "divider", block_id: "d" },
    ];
    expect(validateMessage({ blocks: dup }).map((v) => v.rule)).toEqual(["block_id.unique"]);
  });

  it("reports several broken limits together", () => {
    const m: SlackMessage = {
      text: x(3001),
      blocks: [{ type: "header", block_id: "h", text: pt(x(151)) }],
    };
    expect(validateMessage(m).map((v) => v.rule)).toEqual(["header.text.max", "text.max"]);
  });
});
