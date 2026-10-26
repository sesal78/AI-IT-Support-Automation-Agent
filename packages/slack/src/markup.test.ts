import { describe, expect, it } from "vitest";
import { assertNoLiveMarkup, LiveMarkupError } from "./markup.js";
import { escapeMrkdwn } from "./text.js";

const mk = (text: string) => ({ type: "mrkdwn", text });
const pt = (text: string) => ({ type: "plain_text", text });
const evil = ["<!channel>", "<@U1>", "<http://x>"];

describe("assertNoLiveMarkup", () => {
  it("passes for escaped text", () => {
    for (const e of evil) {
      expect(() =>
        assertNoLiveMarkup({
          text: escapeMrkdwn(e),
          blocks: [{ type: "section", block_id: "s", text: mk(escapeMrkdwn(e)) }],
        }),
      ).not.toThrow();
    }
  });

  it("passes for a plain_text object that holds <!channel>", () => {
    expect(() =>
      assertNoLiveMarkup({
        blocks: [
          { type: "header", block_id: "h", text: pt("<!channel>") },
          { type: "actions", block_id: "a", elements: [{ type: "button", text: pt("<@U1>") }] },
        ],
      }),
    ).not.toThrow();
  });

  it("passes for an empty message", () => {
    expect(() => assertNoLiveMarkup({})).not.toThrow();
    expect(() => assertNoLiveMarkup({ text: "", blocks: [] })).not.toThrow();
  });

  describe.each(evil)("with %s", (bad) => {
    it("throws for a mrkdwn section text and names the block_id, not the text", () => {
      const m = { blocks: [{ type: "section", block_id: "B_sec", text: mk(`hi ${bad}`) }] };
      expect(() => assertNoLiveMarkup(m)).toThrow(LiveMarkupError);
      expect(() => assertNoLiveMarkup(m)).toThrow(/B_sec/);
      expect(() => assertNoLiveMarkup(m)).not.toThrow(/channel|U1|http/);
    });

    it("throws for a section field", () => {
      const m = { blocks: [{ type: "section", block_id: "B_f", fields: [mk("ok"), mk(bad)] }] };
      expect(() => assertNoLiveMarkup(m)).toThrow(/B_f/);
    });

    it("throws for a context element", () => {
      const m = { blocks: [{ type: "context", block_id: "B_c", elements: [pt("ok"), mk(bad)] }] };
      expect(() => assertNoLiveMarkup(m)).toThrow(/B_c/);
    });

    it("throws for a mrkdwn button text and a section accessory", () => {
      const btn = { type: "button", text: mk(bad) };
      expect(() =>
        assertNoLiveMarkup({ blocks: [{ type: "actions", block_id: "B_a", elements: [btn] }] }),
      ).toThrow(/B_a/);
      expect(() =>
        assertNoLiveMarkup({
          blocks: [{ type: "section", block_id: "B_x", text: mk("ok"), accessory: btn }],
        }),
      ).toThrow(/B_x/);
    });

    it("throws for the fallback text without echoing it", () => {
      let message = "";
      try {
        assertNoLiveMarkup({ text: `look ${bad}` });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/fallback/i);
      expect(message).not.toContain(bad);
      expect(message).not.toMatch(/look/);
    });

    it("names the block position when the block has no block_id", () => {
      const m = { blocks: [{ type: "divider" }, { type: "section", text: mk(bad) }] };
      expect(() => assertNoLiveMarkup(m)).toThrow(/index 1/);
      expect(() => assertNoLiveMarkup(m)).not.toThrow(/channel|U1|http/);
    });
  });

  it("finds a mrkdwn object in a block type it does not know", () => {
    const m = { blocks: [{ type: "future", block_id: "B_g", deep: { list: [mk("<!here>")] } }] };
    expect(() => assertNoLiveMarkup(m)).toThrow(/B_g/);
  });

  it("fails closed on a structure nested absurdly deep", () => {
    let deep: unknown = mk("fine");
    for (let i = 0; i < 30; i++) deep = { wrap: deep };
    expect(() => assertNoLiveMarkup({ blocks: [{ type: "x", block_id: "B_d", deep }] })).toThrow(
      /B_d/,
    );
  });

  it("puts no angle bracket in the error", () => {
    let err: Error | undefined;
    try {
      assertNoLiveMarkup({ blocks: [{ type: "section", block_id: "id1", text: mk("<!channel>") }] });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.name).toBe("LiveMarkupError");
    expect(err?.message).not.toContain("<!");
  });
});
