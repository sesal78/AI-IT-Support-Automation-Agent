import { describe, expect, it } from "vitest";
import { internalTicketViewSchema } from "./internal-ticket.js";

const ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-01T10:00:00.000Z";

const valid = {
  id: ID,
  status: "triaged",
  isTest: false,
  source: "web",
  createdAt: AT,
  redacted: { title: "VPN down", description: "Cannot connect" },
  triage: {
    sensitive: false,
    sensitiveFlags: [],
    category: "network",
    subcategory: null,
    priority: "P3",
    urgency: "medium",
    assignmentGroup: "Network",
    route: "auto",
    flags: [],
    probabilities: { network: 0.9 },
    groundingScore: 0.8,
    kbArticleIds: [ID],
    suggestedFix: { steps: ["restart"] },
    modelVersions: { llm: "v1" },
    triagedAt: AT,
  },
  aiCallCount: 2,
  events: [{ type: "received", at: AT }],
  reviews: [],
  notifications: [],
  autofix: [],
};

describe("internalTicketViewSchema", () => {
  it("accepts a triaged ticket", () => {
    expect(internalTicketViewSchema.parse(valid)).toEqual(valid);
  });

  it("accepts null redaction and triage", () => {
    expect(
      internalTicketViewSchema.safeParse({ ...valid, redacted: null, triage: null }).success,
    ).toBe(true);
  });

  it.each(["raw_title", "raw_description", "requester_email", "requester_name", "department"])(
    "rejects a top-level %s key",
    (key) => {
      expect(internalTicketViewSchema.safeParse({ ...valid, [key]: "x" }).success).toBe(false);
    },
  );

  it("rejects extra keys in events and redacted", () => {
    const events = [{ type: "received", at: AT, payload: {} }];
    expect(internalTicketViewSchema.safeParse({ ...valid, events }).success).toBe(false);
    const redacted = { title: "t", description: "d", raw: "r" };
    expect(internalTicketViewSchema.safeParse({ ...valid, redacted }).success).toBe(false);
  });

  it("rejects an unknown status and a non-empty reviews list", () => {
    expect(internalTicketViewSchema.safeParse({ ...valid, status: "weird" }).success).toBe(false);
    expect(internalTicketViewSchema.safeParse({ ...valid, reviews: [1] }).success).toBe(false);
  });
});

describe("internalTicketViewSchema reviews", () => {
  const review = {
    id: ID,
    kind: "triage",
    decision: "approve",
    decidedBy: "U0000000001",
    decidedAt: AT,
    slackTs: "1730000000.000100",
    createdAt: AT,
  };
  const parse = (reviews: unknown[]) =>
    internalTicketViewSchema.safeParse({ ...valid, reviews }).success;

  it("accepts a decided review and an open one with null decision fields", () => {
    expect(parse([review])).toBe(true);
    expect(
      parse([{ ...review, decision: null, decidedBy: null, decidedAt: null, slackTs: null }]),
    ).toBe(true);
  });

  it("rejects an unknown key, such as the wait token, in a review", () => {
    expect(parse([{ ...review, waitTokenId: "marker" }])).toBe(false);
    expect(parse([{ ...review, wait_token_id: "marker" }])).toBe(false);
  });

  it("rejects a missing key, an unknown kind and an unknown decision", () => {
    const missing: Partial<typeof review> = { ...review };
    delete missing.slackTs;
    expect(parse([missing])).toBe(false);
    expect(parse([{ ...review, kind: "other" }])).toBe(false);
    expect(parse([{ ...review, decision: "maybe" }])).toBe(false);
    expect(parse([{ ...review, id: "not-a-uuid" }])).toBe(false);
  });
});
