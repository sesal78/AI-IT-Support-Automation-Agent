import { describe, expect, it } from "vitest";
import { internalTicketViewSchema } from "./internal-ticket.js";

const ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-01T10:00:00.000Z";

const valid = {
  id: ID,
  number: "ITS-000042",
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
  incident: null,
};

describe("internalTicketViewSchema", () => {
  it("accepts a triaged ticket", () => {
    expect(internalTicketViewSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a view without a number, or with a bad one", () => {
    const withoutNumber: Partial<typeof valid> = { ...valid };
    delete withoutNumber.number;
    expect(internalTicketViewSchema.safeParse(withoutNumber).success).toBe(false);
    for (const number of ["ITS-1", "its-000042", "ITS-0000042", "INC0010001", ID, 42]) {
      expect(internalTicketViewSchema.safeParse({ ...valid, number }).success, String(number)).toBe(
        false,
      );
    }
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

describe("internalTicketViewSchema incident (P5-T5b)", () => {
  const incident = { number: "INC0010001", sysId: "1".repeat(32) };
  const parse = (value: unknown) =>
    internalTicketViewSchema.safeParse({ ...valid, incident: value }).success;

  it("accepts the helpdesk number with its sys_id, and null", () => {
    expect(parse(incident)).toBe(true);
    expect(parse(null)).toBe(true);
  });

  it("rejects an extra key in the incident", () => {
    expect(parse({ ...incident, short_description: "marker" })).toBe(false);
    expect(parse({ ...incident, externalId: incident.sysId })).toBe(false);
  });

  it("rejects a missing or empty field, and a value that is not an object", () => {
    expect(parse({ number: incident.number })).toBe(false);
    expect(parse({ sysId: incident.sysId })).toBe(false);
    expect(parse({ ...incident, number: "" })).toBe(false);
    expect(parse({ ...incident, sysId: "" })).toBe(false);
    expect(parse(incident.number)).toBe(false);
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

describe("internalTicketViewSchema notifications (P5-T8b)", () => {
  const id = "6f1e3c0e-5b8a-4d7e-9c52-0a1b2c3d4e5f";
  const notification = {
    id,
    channel: "email",
    kind: "incident_reply",
    status: "sent",
    reason: null,
    providerId: "msg_01",
    at: AT,
  };

  it("lists a notification with all seven keys", () => {
    const view = { ...valid, notifications: [notification] };
    expect(internalTicketViewSchema.parse(view).notifications).toEqual([notification]);
  });

  it("accepts a skipped and a failed entry", () => {
    const skipped = {
      ...notification,
      status: "skipped",
      reason: "not_allow_listed",
      providerId: null,
    };
    const failed = {
      ...notification,
      kind: "needs_info",
      status: "failed",
      reason: "provider_error",
      providerId: null,
    };
    expect(
      internalTicketViewSchema.safeParse({ ...valid, notifications: [skipped, failed] }).success,
    ).toBe(true);
  });

  it("rejects an entry with an unknown key (for example the address)", () => {
    const view = { ...valid, notifications: [{ ...notification, to: "a@b.test" }] };
    expect(internalTicketViewSchema.safeParse(view).success).toBe(false);
  });

  it.each(["id", "channel", "kind", "status", "reason", "providerId", "at"])(
    "rejects an entry without %s",
    (key) => {
      const entry: Record<string, unknown> = { ...notification };
      delete entry[key];
      expect(internalTicketViewSchema.safeParse({ ...valid, notifications: [entry] }).success).toBe(
        false,
      );
    },
  );

  it.each([
    ["an unknown channel", { channel: "sms" }],
    ["an unknown kind", { kind: "welcome" }],
    ["an unknown status", { status: "queued" }],
    ["an unknown reason", { reason: "bounced" }],
    ["a non-UUID id", { id: "nope" }],
    ["a bad timestamp", { at: "yesterday" }],
  ])("rejects %s", (_name, patch) => {
    const view = { ...valid, notifications: [{ ...notification, ...patch }] };
    expect(internalTicketViewSchema.safeParse(view).success).toBe(false);
  });
});
