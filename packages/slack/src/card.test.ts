import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDecidedCard,
  buildReviewCard,
  buildTimedOutCard,
  buildTimeoutNote,
  type ReviewCardInput,
} from "./card.js";
import { validateMessage, type SlackMessage } from "./limits.js";
import { assertNoLiveMarkup } from "./markup.js";

const REVIEW_ID = "0b6f3c1e-9d2a-4f7b-8c11-2a3b4c5d6e7f";
const TICKET_ID = "5e8a1f20-7c3d-4b9e-a012-3456789abcde";
const REVIEWER = "U00000000AB";
const DECIDED_AT = new Date("2026-10-25T03:04:05.678Z");

const base = (): ReviewCardInput => ({
  reviewId: REVIEW_ID,
  ticketId: TICKET_ID,
  environment: "e2e",
  timeout: "24h",
  redactedTitle: "Complaint about a colleague",
  redactedDescription: "My manager [NAME] keeps raising their voice in meetings.",
  category: "inquiry",
  priority: "P3",
  urgency: "medium",
  assignmentGroup: "Service Desk",
  reasons: ["sensitive", "ungrounded_fix"],
  flags: ["hr", "ungrounded_fix"],
  kbArticles: [{ title: "Raising a workplace concern", slug: "workplace-concern" }],
  fixSteps: { steps: ["Acknowledge the report", "Route it to HR"], caveats: [] },
});

type TextObj = { type: string; text: string; path: string };

/** Every Slack text object (an object with `type` and a string `text`) in a message. */
function textObjects(node: unknown, path = "$", out: TextObj[] = []): TextObj[] {
  if (Array.isArray(node)) {
    node.forEach((n, i) => textObjects(n, `${path}[${i}]`, out));
  } else if (typeof node === "object" && node !== null) {
    const o = node as Record<string, unknown>;
    if (typeof o.type === "string" && typeof o.text === "string") {
      out.push({ type: o.type, text: o.text, path });
    }
    for (const [k, v] of Object.entries(o)) textObjects(v, `${path}.${k}`, out);
  }
  return out;
}

/** The block fields these tests read. */
interface LooseBlock {
  text: { type: string; text: string };
  fields: { type: string; text: string }[];
  elements: { type: string; text: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

const blockOf = (message: SlackMessage, id: string): LooseBlock => {
  const block = message.blocks?.find((b) => b.block_id === id);
  if (!block) throw new Error(`no block ${id}`);
  return block as unknown as LooseBlock;
};

const sectionText = (message: SlackMessage, id: string): string => blockOf(message, id).text.text;

function expectValid(message: SlackMessage): void {
  expect(validateMessage(message)).toEqual([]);
  expect(() => assertNoLiveMarkup(message)).not.toThrow();
}

const maxInput = (unit = "x"): ReviewCardInput => {
  const fill = (n: number) => unit.repeat(n);
  return {
    ...base(),
    redactedTitle: fill(3000),
    redactedDescription: fill(5000),
    category: "password_reset",
    assignmentGroup: "IT Securities",
    reasons: [
      "sensitive",
      "injection_suspected",
      "needs_info",
      "low_confidence",
      "p1",
      "outage_or_duplicate",
      "ungrounded_fix",
      "cap_reached",
      "llm_unavailable",
    ],
    flags: ["injection_suspected", "needs_info", "ungrounded_fix", "outage_or_duplicate", "hr"],
    kbArticles: [1, 2, 3].map(() => ({ title: fill(200), slug: fill(120) })),
    fixSteps: {
      steps: Array.from({ length: 8 }, () => fill(500)),
      caveats: Array.from({ length: 5 }, () => fill(300)),
    },
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildReviewCard layout", () => {
  it("has the blocks in the approved order", () => {
    const card = buildReviewCard(base());
    expect(card.blocks.map((b) => [b.type, b.block_id])).toEqual([
      ["header", "review_header"],
      ["section", "review_why"],
      ["section", "review_fields"],
      ["section", "review_description"],
      ["section", "review_steps"],
      ["section", "review_kb"],
      ["actions", "review_actions"],
      ["context", "review_context"],
    ]);
  });

  it("titles the header and the fallback text", () => {
    const card = buildReviewCard(base());
    expect(blockOf(card, "review_header").text).toEqual({
      type: "plain_text",
      text: "Review needed: Complaint about a colleague",
      emoji: false,
    });
    expect(card.text).toBe("Review needed: Complaint about a colleague");
  });

  it("has exactly two buttons, each carrying the review ID", () => {
    const actions = blockOf(buildReviewCard(base()), "review_actions");
    expect(actions.elements).toEqual([
      {
        type: "button",
        text: { type: "plain_text", text: "Approve", emoji: false },
        action_id: "review_approve",
        style: "primary",
        value: REVIEW_ID,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Reject", emoji: false },
        action_id: "review_reject",
        style: "danger",
        value: REVIEW_ID,
      },
    ]);
  });

  it("ends with the ticket, environment and timeout context line", () => {
    const context = blockOf(
      buildReviewCard({ ...base(), environment: "staging" }),
      "review_context",
    );
    expect(context.elements).toEqual([
      {
        type: "plain_text",
        text: "Ticket 5e8a1f20 · staging · decide within 24h, then it goes to the manual queue",
        emoji: false,
      },
    ]);
  });

  it("shows the four triage fields", () => {
    const fields = blockOf(buildReviewCard(base()), "review_fields").fields;
    expect(fields).toEqual([
      { type: "plain_text", text: "Category: inquiry", emoji: false },
      { type: "plain_text", text: "Priority: P3", emoji: false },
      { type: "plain_text", text: "Urgency: medium", emoji: false },
      { type: "plain_text", text: "Group: Service Desk", emoji: false },
    ]);
  });

  it("shows not judged for null fields", () => {
    const card = buildReviewCard({
      ...base(),
      category: null,
      priority: null,
      urgency: null,
      assignmentGroup: null,
    });
    expect(blockOf(card, "review_fields").fields.map((f) => f.text)).toEqual([
      "Category: not judged",
      "Priority: not judged",
      "Urgency: not judged",
      "Group: not judged",
    ]);
  });
});

describe("buildReviewCard why line", () => {
  const why = (reasons: string[], flags: string[]) =>
    sectionText(buildReviewCard({ ...base(), reasons, flags }), "review_why");

  it("reads the approved sentence for sensitive + hr + ungrounded_fix", () => {
    expect(why(["sensitive", "ungrounded_fix"], ["hr", "ungrounded_fix"])).toBe(
      "Why: sensitive topic (HR) · fix steps not backed by a KB article",
    );
  });

  it.each([
    ["ungrounded_fix", "fix steps not backed by a KB article"],
    ["low_confidence", "low triage confidence"],
    ["p1", "priority P1"],
    ["injection_suspected", "possible prompt injection"],
    ["needs_info", "ticket needs more detail"],
    ["outage_or_duplicate", "possible outage or duplicate"],
    ["cap_reached", "AI call cap reached"],
    ["llm_unavailable", "fix-step model unavailable"],
    ["sensitive", "sensitive topic"],
  ])("maps %s to its fixed wording", (code, words) => {
    expect(why([code], [])).toBe(`Why: ${words}`);
  });

  it("shows a flag that repeats a reason only once", () => {
    expect(why(["needs_info", "p1"], ["needs_info"])).toBe(
      "Why: ticket needs more detail · priority P1",
    );
  });

  it("shows a reason flag without its reason in its fixed wording", () => {
    expect(why(["p1"], ["outage_or_duplicate"])).toBe(
      "Why: priority P1 · possible outage or duplicate",
    );
  });

  it("lists every topic flag of a sensitive ticket in brackets", () => {
    expect(why(["sensitive"], ["hr", "legal"])).toBe("Why: sensitive topic (HR, legal)");
  });

  it("shows unknown codes as they are", () => {
    expect(why(["brand_new", "p1"], ["odd_flag"])).toBe("Why: brand_new · priority P1 · odd_flag");
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "shows the prototype key %s as a plain code",
    (code) => {
      expect(why([code], [code])).toBe(`Why: ${code}`);
      expect(why(["sensitive"], [code])).toBe(`Why: sensitive topic (${code})`);
    },
  );

  it("keeps an unknown code holding markup in plain text", () => {
    const card = buildReviewCard({ ...base(), reasons: ["<!channel>"], flags: ["<@U00000000>"] });
    expect(blockOf(card, "review_why").text).toEqual({
      type: "plain_text",
      text: "Why: <!channel> · <@U00000000>",
      emoji: false,
    });
    expectValid(card);
  });

  it("shows a repeated code once", () => {
    expect(why(["p1", "p1"], ["odd", "odd"])).toBe("Why: priority P1 · odd");
  });

  it("does not treat a flag that repeats an unknown reason as a topic", () => {
    expect(why(["brand_new", "sensitive"], ["brand_new", "hr"])).toBe(
      "Why: brand_new · sensitive topic (HR)",
    );
  });

  it("says when no reason was given", () => {
    expect(why([], [])).toBe("Why: no reason given");
  });
});

describe("buildReviewCard description, steps and KB", () => {
  it("cuts a 1000-character description to 600 ending in …", () => {
    const text = sectionText(
      buildReviewCard({ ...base(), redactedDescription: "d".repeat(1000) }),
      "review_description",
    );
    const body = text.slice("Ticket (redacted)\n".length);
    expect(text.startsWith("Ticket (redacted)\n")).toBe(true);
    expect(Array.from(body)).toHaveLength(600);
    expect(body.endsWith("…")).toBe(true);
    expect(body.slice(0, 599)).toBe("d".repeat(599));
  });

  it("keeps a 600-character description whole", () => {
    const text = sectionText(
      buildReviewCard({ ...base(), redactedDescription: "d".repeat(600) }),
      "review_description",
    );
    expect(text).toBe(`Ticket (redacted)\n${"d".repeat(600)}`);
  });

  it("shows 3 of 5 steps and points to the thread, which holds all 5", () => {
    const steps = ["one", "two", "three", "four", "five"];
    const card = buildReviewCard({ ...base(), fixSteps: { steps, caveats: [] } });
    expect(sectionText(card, "review_steps")).toBe(
      "Suggested fix steps\n1. one\n2. two\n3. three\n+2 more steps in the thread",
    );
    expect(card.threadSteps).not.toBeNull();
    expect(sectionText(card.threadSteps!, "review_thread_steps")).toBe(
      "Suggested fix steps\n1. one\n2. two\n3. three\n4. four\n5. five",
    );
    expect(card.threadSteps!.text).toBe("All suggested fix steps");
    expectValid(card.threadSteps!);
  });

  it("gives threadSteps null for 3 steps and no caveats", () => {
    const card = buildReviewCard({ ...base(), fixSteps: { steps: ["a", "b", "c"], caveats: [] } });
    expect(card.threadSteps).toBeNull();
    expect(sectionText(card, "review_steps")).toBe("Suggested fix steps\n1. a\n2. b\n3. c");
  });

  it("puts caveats in the thread even with few steps", () => {
    const card = buildReviewCard({
      ...base(),
      fixSteps: { steps: ["a"], caveats: ["needs admin rights", "close apps first"] },
    });
    expect(sectionText(card.threadSteps!, "review_thread_steps")).toBe(
      "Suggested fix steps\n1. a\nCaveats\n- needs admin rights\n- close apps first",
    );
  });

  it("numbers 8 steps 1. to 8. in the thread", () => {
    const steps = Array.from({ length: 8 }, (_, i) => `s${i + 1}`);
    const card = buildReviewCard({ ...base(), fixSteps: { steps, caveats: [] } });
    const lines = sectionText(card.threadSteps!, "review_thread_steps").split("\n").slice(1);
    expect(lines).toEqual(steps.map((s, i) => `${i + 1}. ${s}`));
  });

  it.each([
    ["null", null],
    ["no steps", { steps: [], caveats: [] }],
  ])("shows none drafted for %s", (_case, fixSteps) => {
    const card = buildReviewCard({ ...base(), fixSteps });
    expect(sectionText(card, "review_steps")).toBe("Suggested fix steps\nnone drafted");
    expect(card.threadSteps).toBeNull();
  });

  it("keeps the more-steps line when the shown steps are long", () => {
    const steps = Array.from({ length: 5 }, () => "s".repeat(2000));
    const text = sectionText(
      buildReviewCard({ ...base(), fixSteps: { steps, caveats: [] } }),
      "review_steps",
    );
    expect(text.endsWith("…\n+2 more steps in the thread")).toBe(true);
    expect(Array.from(text).length).toBeLessThanOrEqual(3000);
  });

  it("lists KB articles as title (slug) joined by ·", () => {
    const card = buildReviewCard({
      ...base(),
      kbArticles: [
        { title: "Reset a password", slug: "reset-password" },
        { title: "VPN setup", slug: "vpn" },
      ],
    });
    expect(sectionText(card, "review_kb")).toBe(
      "KB articles\nReset a password (reset-password) · VPN setup (vpn)",
    );
  });

  it("shows none for no KB article, and at most 3", () => {
    expect(sectionText(buildReviewCard({ ...base(), kbArticles: [] }), "review_kb")).toBe(
      "KB articles\nnone",
    );
    const four = [1, 2, 3, 4].map((n) => ({ title: `t${n}`, slug: `s${n}` }));
    expect(sectionText(buildReviewCard({ ...base(), kbArticles: four }), "review_kb")).toBe(
      "KB articles\nt1 (s1) · t2 (s2) · t3 (s3)",
    );
  });
});

describe("buildReviewCard limits (T4.X.01)", () => {
  it("passes both validators with every field at its maximum", () => {
    const card = buildReviewCard(maxInput());
    expectValid(card);
    expect(card.threadSteps).not.toBeNull();
    expectValid(card.threadSteps!);
  });

  it.each(["😀", "漢", "é", "👩‍💻"])("passes both validators at maximum with %s", (unit) => {
    const card = buildReviewCard(maxInput(unit));
    expectValid(card);
    expectValid(card.threadSteps!);
  });

  it("keeps a title made only of < within the limits after escaping", () => {
    const card = buildReviewCard({ ...base(), redactedTitle: "<".repeat(3000) });
    expectValid(card);
    expect(card.text).not.toContain("<");
    expect(card.text.startsWith("Review needed: &lt;")).toBe(true);
    expect(Array.from(card.text).length).toBeLessThanOrEqual(3000);
    expect(Array.from(blockOf(card, "review_header").text.text)).toHaveLength(150);
  });

  it("truncates before escaping, so no entity is cut", () => {
    const card = buildReviewCard({ ...base(), redactedTitle: "&".repeat(3000) });
    expect(card.text).toBe(`Review needed: ${"&amp;".repeat(134)}…`);
  });
});

describe("buildReviewCard output safety (T4.S.02)", () => {
  const evil = "<!channel> <!here> <@U00000000> <https://evil.example|click> *bold*";

  const evilInput = (): ReviewCardInput => ({
    ...base(),
    redactedTitle: evil,
    redactedDescription: evil,
    category: evil,
    priority: evil,
    urgency: evil,
    assignmentGroup: evil,
    reasons: [evil],
    flags: [evil],
    kbArticles: [{ title: evil, slug: evil }],
    fixSteps: { steps: [evil, evil, evil, evil], caveats: [evil] },
  });

  it("passes assertNoLiveMarkup and keeps the text unchanged in plain_text", () => {
    const card = buildReviewCard(evilInput());
    expectValid(card);
    expectValid(card.threadSteps!);
    expect(blockOf(card, "review_header").text.text).toBe(`Review needed: ${evil}`);
    expect(sectionText(card, "review_description")).toBe(`Ticket (redacted)\n${evil}`);
    expect(sectionText(card, "review_kb")).toBe(`KB articles\n${evil} (${evil})`);
    expect(card.text).toContain("&lt;!channel&gt;");
    expect(card.text).not.toContain("<");
  });

  it("puts every text object of the card and thread in plain_text", () => {
    const card = buildReviewCard(evilInput());
    for (const message of [card, card.threadSteps!]) {
      const objects = textObjects(message.blocks);
      expect(objects.length).toBeGreaterThan(0);
      for (const obj of objects) expect(obj.type, obj.path).toBe("plain_text");
    }
  });

  it("sets emoji: false, so shortcodes are not turned into emoji", () => {
    for (const obj of textObjects(buildReviewCard(base()).blocks)) {
      expect((obj as unknown as { emoji?: boolean }).emoji ?? false, obj.path).toBe(false);
    }
  });

  it("holds no marker from keys outside the input type", () => {
    const markers = [
      "MARKER_NAME_1",
      "MARKER_EMAIL_2",
      "MARKER_RAW_3",
      "MARKER_TOKEN_4",
      "MARKER_URL_5",
    ];
    const input = {
      ...base(),
      requesterName: markers[0],
      requesterEmail: markers[1],
      rawDescription: markers[2],
      token: markers[3],
      url: markers[4],
      kbArticles: [{ title: "t", slug: "s", url: markers[4], body: markers[2] }],
      fixSteps: { steps: ["a", "b", "c", "d"], caveats: [], raw: markers[2] },
    } as unknown as ReviewCardInput;
    const json = JSON.stringify([
      buildReviewCard(input),
      buildDecidedCard(input, {
        decision: "approve",
        slackUserId: REVIEWER,
        decidedAt: DECIDED_AT,
      }),
      buildTimedOutCard(input),
    ]);
    for (const marker of markers) expect(json).not.toContain(marker);
  });
});

describe("buildReviewCard input checks", () => {
  it.each([
    ["reviewId", "not-a-uuid"],
    ["reviewId", ""],
    ["reviewId", `${REVIEW_ID}<!channel>`],
    ["reviewId", `<!channel>${REVIEW_ID}`],
    ["reviewId", 42],
    ["ticketId", "1234"],
    ["ticketId", `x${TICKET_ID}`],
    ["ticketId", undefined],
    ["environment", "production"],
    ["timeout", "forever"],
    ["timeout", "24h<!here>"],
    ["timeout", ""],
    ["redactedTitle", undefined],
    ["redactedDescription", 7],
    ["category", 3],
    ["reasons", "sensitive"],
    ["flags", [1]],
    ["kbArticles", [{ title: 1, slug: "s" }]],
    ["kbArticles", null],
    ["fixSteps", { steps: "a", caveats: [] }],
    ["fixSteps", { steps: [], caveats: [null] }],
  ])("throws for a bad %s, naming the field and not the value", (key, value) => {
    let error: unknown;
    try {
      buildReviewCard({ ...base(), [key]: value } as unknown as ReviewCardInput);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(new RegExp(`^review card: ${key} must be [a-z0-9]`));
    expect((error as Error).message).toContain(key);
    if (typeof value === "string" && value !== "") {
      expect((error as Error).message).not.toContain(value);
    }
  });

  it("accepts an upper-case review UUID", () => {
    expect(() => buildReviewCard({ ...base(), reviewId: REVIEW_ID.toUpperCase() })).not.toThrow();
  });
});

describe("buildDecidedCard", () => {
  const decided = (decision: "approve" | "reject" = "approve") =>
    buildDecidedCard(base(), { decision, slackUserId: REVIEWER, decidedAt: DECIDED_AT });

  it("keeps the header and fields and drops the rest", () => {
    const card = decided();
    expect(card.blocks.map((b) => [b.type, b.block_id])).toEqual([
      ["header", "review_header"],
      ["section", "review_fields"],
      ["context", "review_decision"],
      ["context", "review_summary"],
    ]);
    expect(card.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(blockOf(card, "review_header").text.text).toBe("Reviewed: Complaint about a colleague");
    expect(blockOf(card, "review_fields")).toEqual(
      blockOf(buildReviewCard(base()), "review_fields"),
    );
    expect(card.text).toBe("Reviewed: Complaint about a colleague");
  });

  it.each([
    ["approve", "Approved"],
    ["reject", "Rejected"],
  ] as const)("names the %s decision, the reviewer and the time", (decision, word) => {
    expect(blockOf(decided(decision), "review_decision").elements).toEqual([
      { type: "mrkdwn", text: `${word} by <@${REVIEWER}> at 2026-10-25T03:04:05.678Z` },
    ]);
  });

  it("accepts the time as an ISO string", () => {
    const card = buildDecidedCard(base(), {
      decision: "reject",
      slackUserId: REVIEWER,
      decidedAt: "2026-10-25T03:04:05.678Z",
    });
    expect(blockOf(card, "review_decision").elements[0]!.text).toContain(
      "2026-10-25T03:04:05.678Z",
    );
  });

  it("adds the summary line", () => {
    expect(blockOf(decided(), "review_summary").elements).toEqual([
      {
        type: "plain_text",
        text: "Category inquiry · P3 · Service Desk · ticket 5e8a1f20",
        emoji: false,
      },
    ]);
    const nulls = buildDecidedCard(
      { ...base(), category: null, priority: null, assignmentGroup: null },
      { decision: "approve", slackUserId: REVIEWER, decidedAt: DECIDED_AT },
    );
    expect(blockOf(nulls, "review_summary").elements[0]!.text).toBe(
      "Category not judged · priority not judged · group not judged · ticket 5e8a1f20",
    );
  });

  it("passes validateMessage, and assertNoLiveMarkup apart from the one reviewer mention", () => {
    const card = buildDecidedCard(maxInput("😀"), {
      decision: "approve",
      slackUserId: REVIEWER,
      decidedAt: DECIDED_AT,
    });
    expect(validateMessage(card)).toEqual([]);
    const mrkdwn = textObjects(card).filter((o) => o.type === "mrkdwn");
    expect(mrkdwn).toHaveLength(1);
    expect(mrkdwn[0]!.text).toMatch(/^(Approved|Rejected) by <@[UW][A-Z0-9]{8,12}> at \S+Z$/);
    expect(() =>
      assertNoLiveMarkup({
        ...card,
        blocks: card.blocks.filter((b) => b.block_id !== "review_decision"),
      }),
    ).not.toThrow();
    expect(card.text).not.toContain("<");
  });

  it("keeps ticket text out of mrkdwn even when it holds markup", () => {
    const evil = "<!channel> <@U00000000>";
    const card = buildDecidedCard(
      { ...base(), redactedTitle: evil, category: evil, assignmentGroup: evil },
      { decision: "approve", slackUserId: REVIEWER, decidedAt: DECIDED_AT },
    );
    const mrkdwn = textObjects(card).filter((o) => o.type === "mrkdwn");
    expect(mrkdwn.map((o) => o.text)).toEqual([
      `Approved by <@${REVIEWER}> at 2026-10-25T03:04:05.678Z`,
    ]);
    expect(card.text).toContain("&lt;!channel&gt;");
  });

  it.each(["", "u00000000", "U123", "<!channel>", `${REVIEWER}>`, "C00000000", " U00000000"])(
    "throws for the slackUserId %j before building",
    (slackUserId) => {
      expect(() =>
        buildDecidedCard(base(), { decision: "approve", slackUserId, decidedAt: DECIDED_AT }),
      ).toThrow(TypeError);
    },
  );

  it("throws for an unknown decision or a bad time", () => {
    expect(() =>
      buildDecidedCard(base(), {
        decision: "timeout" as "approve",
        slackUserId: REVIEWER,
        decidedAt: DECIDED_AT,
      }),
    ).toThrow(/decision/);
    expect(() =>
      buildDecidedCard(base(), { decision: "approve", slackUserId: REVIEWER, decidedAt: "soon" }),
    ).toThrow(/decidedAt/);
    expect(() =>
      buildDecidedCard(base(), {
        decision: "approve",
        slackUserId: REVIEWER,
        decidedAt: new Date(Number.NaN),
      }),
    ).toThrow(/decidedAt/);
  });

  it("checks the card input too", () => {
    expect(() =>
      buildDecidedCard(
        { ...base(), reviewId: "x" },
        {
          decision: "approve",
          slackUserId: REVIEWER,
          decidedAt: DECIDED_AT,
        },
      ),
    ).toThrow(/reviewId/);
  });
});

describe("buildTimedOutCard and buildTimeoutNote", () => {
  it("has no actions block and names the timeout", () => {
    const card = buildTimedOutCard(base());
    expect(card.blocks.map((b) => [b.type, b.block_id])).toEqual([
      ["header", "review_header"],
      ["section", "review_fields"],
      ["context", "review_timeout"],
      ["context", "review_summary"],
    ]);
    expect(blockOf(card, "review_header").text.text).toBe(
      "Review timed out: Complaint about a colleague",
    );
    expect(blockOf(card, "review_timeout").elements).toEqual([
      {
        type: "plain_text",
        text: "No decision within 24h: sent to the manual queue",
        emoji: false,
      },
    ]);
    expect(card.text).toBe("Review timed out: Complaint about a colleague");
  });

  it("passes both validators at maximum input", () => {
    expectValid(buildTimedOutCard(maxInput("漢")));
    expectValid(buildTimedOutCard({ ...base(), redactedTitle: "<".repeat(3000) }));
    for (const obj of textObjects(buildTimedOutCard(maxInput())))
      expect(obj.type).toBe("plain_text");
  });

  it("builds the thread note with the same sentence", () => {
    const note = buildTimeoutNote({ timeout: "4m" });
    expect(note).toEqual({ text: "No decision within 4m: sent to the manual queue" });
    expectValid(note);
  });

  it.each(["", "24 hours", "<!channel>", "24h\n", "99999h"])(
    "throws for the timeout %j",
    (timeout) => {
      expect(() => buildTimeoutNote({ timeout })).toThrow(/timeout/);
    },
  );
});

describe("purity", () => {
  it("gives deep-equal results for the same input and leaves the input alone", () => {
    const input = maxInput("é");
    const frozen = structuredClone(input);
    const opts = { decision: "reject", slackUserId: REVIEWER, decidedAt: DECIDED_AT } as const;
    expect(buildReviewCard(input)).toEqual(buildReviewCard(input));
    expect(buildDecidedCard(input, opts)).toEqual(buildDecidedCard(input, opts));
    expect(buildTimedOutCard(input)).toEqual(buildTimedOutCard(input));
    expect(buildTimeoutNote({ timeout: "24h" })).toEqual(buildTimeoutNote({ timeout: "24h" }));
    expect(input).toEqual(frozen);
  });

  it("does no I/O and no logging", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    buildReviewCard(maxInput());
    buildDecidedCard(base(), { decision: "approve", slackUserId: REVIEWER, decidedAt: DECIDED_AT });
    buildTimedOutCard(base());
    buildTimeoutNote({ timeout: "24h" });
    for (const spy of [...spies, fetchSpy]) expect(spy).not.toHaveBeenCalled();
  });
});
