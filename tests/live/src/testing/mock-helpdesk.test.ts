// The mock phase 5 flow, driven directly (no HTTP): each step lands at its own
// time, the incident is a real Table API row, and the faults show the negative
// cases the scenarios use.
import { beforeEach, describe, expect, it } from "vitest";
import type { MockRequest } from "./mock-e2e.ts";
import { createMockHelpdesk, type MockHelpdesk, type MockHelpdeskFaults } from "./mock-helpdesk.ts";
import { mockResend, type MockResend } from "./mock-resend.ts";
import { fullInstance, type MockSnData } from "./mock-servicenow.ts";

const T0 = Date.parse("2026-11-13T00:00:00Z");
const PRINTER = {
  title: "Printer on level 2 is offline",
  description: "The printer shows a paper jam and will not print.",
};

let now = T0;
let data: MockSnData;
let helpdesk: MockHelpdesk;

beforeEach(() => {
  now = T0;
  data = fullInstance();
  helpdesk = createMockHelpdesk({ now: () => now, data });
});

function request(path: string, body: unknown = {}): MockRequest {
  return {
    method: path.startsWith("/api/internal/tickets/") ? "GET" : "POST",
    path,
    query: new URLSearchParams(),
    accessOk: true,
    hasAccessHeaders: true,
    bearerOk: true,
    hasBearer: true,
    hasAuthorization: true,
    body: JSON.stringify(body),
    at: now,
    slack: null,
  };
}

const create = (body: Record<string, unknown>) =>
  helpdesk.override(request("/api/internal/test-tickets", body))!.json as Record<string, unknown>;

const viewOf = (mock: MockHelpdesk, testId: string) =>
  mock.override(request(`/api/internal/tickets/${mock.tickets.get(testId)!.ticketId}`))!
    .json as Record<string, unknown>;

/** Moves the fake clock to `ms` after T0 and lets every scheduled step land. */
function at(ms: number) {
  now = T0 + ms;
  helpdesk.tick();
}

describe("the mock phase 5 flow", () => {
  it("moves a ticket to one [E2E] incident, with the ticket number as display", () => {
    const created = create({ testId: "run:L01:1", email: "demo.carol@example.com", ...PRINTER });
    at(999);
    expect(viewOf(helpdesk, "run:L01:1")["status"]).toBe("new");
    at(1_000);
    expect(viewOf(helpdesk, "run:L01:1")["status"]).toBe("redacted");
    at(5_000);
    expect(viewOf(helpdesk, "run:L01:1")).toMatchObject({
      status: "auto",
      triage: { category: "hardware", route: "auto" },
      incident: null,
    });
    at(6_000);
    const pending = viewOf(helpdesk, "run:L01:1");
    expect(pending["status"]).toBe("helpdesk_pending");
    expect(pending["events"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "helpdesk_sync_started" })]),
    );
    at(7_000);
    expect(viewOf(helpdesk, "run:L01:1")).toMatchObject({
      status: "incident_created",
      aiCallCount: 1,
      incident: { number: "INC0000001" },
    });
    expect(data.incidents[0]).toMatchObject({
      category: "hardware",
      caller_id: data.users.find((u) => u["user_name"] === "demo.carol")!["sys_id"],
      correlation_id: created["ticketId"],
      correlation_display: created["ticketNumber"],
      short_description: "[E2E] Printer on level 2 is offline",
      state: "1",
    });
    expect(data.journal.filter((j) => j["element"] === "work_notes")).toHaveLength(1);
  });

  it("answers a repeated test ID with the same ticket and duplicate: true", () => {
    const body = { testId: "run:L03:1", email: "demo.carol@example.com", ...PRINTER };
    const first = create(body);
    const second = create(body);
    expect(second).toMatchObject({
      ticketId: first["ticketId"],
      ticketNumber: first["ticketNumber"],
      duplicate: true,
    });
    expect(helpdesk.tickets.size).toBe(1);
  });

  it("skips the incident in shadow mode", () => {
    create({
      testId: "run:L05:1",
      email: "demo.carol@example.com",
      ...PRINTER,
      testOverrides: { shadowMode: true },
    });
    at(7_000);
    const view = viewOf(helpdesk, "run:L05:1");
    expect(view["status"]).toBe("incident_skipped_shadow");
    expect(view["events"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "shadow_skipped" })]),
    );
    expect(data.incidents).toEqual([]);
  });

  it("answers nothing without the Access gate or the bearer token", () => {
    expect(helpdesk.override({ ...request("/api/internal/test-tickets"), accessOk: false })).toBe(
      undefined,
    );
    expect(helpdesk.override({ ...request("/api/internal/test-tickets"), bearerOk: false })).toBe(
      undefined,
    );
    expect(helpdesk.tickets.size).toBe(0);
  });
});

describe("the mock reply emails (P5-T8c)", () => {
  const RECIPIENT = "marker-recipient@example.test";
  const VAGUE = { title: "It's broken", description: "it's broken, please fix" };
  let resend: MockResend;

  /** The mock helpdesk, now able to send the two emails through the Resend mock. */
  function withEmails(faults: MockHelpdeskFaults = {}): MockHelpdesk {
    resend = mockResend({ now: () => now });
    return createMockHelpdesk({
      now: () => now,
      data,
      replyRecipient: RECIPIENT,
      resend,
      faults,
    });
  }

  const notifications = (mock: MockHelpdesk, testId: string) =>
    viewOf(mock, testId)["notifications"] as Array<Record<string, unknown>>;

  const subjects = () => [...resend.emails.values()].map((email) => email.subject);

  it("sends one incident reply with a provider id once the incident exists", () => {
    helpdesk = withEmails();
    create({ testId: "run:L06:1", email: RECIPIENT, ...PRINTER });
    at(7_000);
    const sent = notifications(helpdesk, "run:L06:1");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: "email",
      kind: "incident_reply",
      status: "sent",
      reason: null,
    });
    expect(typeof sent[0]!["providerId"]).toBe("string");
    expect(subjects()).toEqual(["[E2E] Your IT ticket ITS-000001"]);
    expect([...resend.emails.values()][0]!.text).toContain("INC0000001");
    // A later read does not send a second email.
    at(8_000);
    expect(notifications(helpdesk, "run:L06:1")).toHaveLength(1);
    expect(resend.emails.size).toBe(1);
  });

  it("sends needs_info for a vague report before any incident, with the details subject", () => {
    helpdesk = withEmails();
    create({ testId: "run:L07:1", email: RECIPIENT, ...VAGUE });
    at(6_000);
    const view = viewOf(helpdesk, "run:L07:1");
    expect(view).toMatchObject({
      status: "review_pending",
      triage: { route: "review", flags: ["needs_info"] },
    });
    expect(view["notifications"]).toEqual([
      expect.objectContaining({
        kind: "needs_info",
        status: "sent",
        providerId: expect.any(String),
      }),
    ]);
    expect(subjects()).toEqual(["[E2E] More detail needed for your IT ticket ITS-000001"]);
  });

  it("skips the email as not_allow_listed for an address off the list, and sends nothing", () => {
    helpdesk = withEmails();
    create({ testId: "run:S01:1", email: "canary+run1234@example.com", ...VAGUE });
    at(6_000);
    expect(notifications(helpdesk, "run:S01:1")).toEqual([
      expect.objectContaining({
        kind: "needs_info",
        status: "skipped",
        reason: "not_allow_listed",
        providerId: null,
      }),
    ]);
    expect(resend.emails.size).toBe(0);
  });

  it("skips every address when no mailbox is configured, and sends nothing", () => {
    resend = mockResend({ now: () => now });
    helpdesk = createMockHelpdesk({ now: () => now, data, resend });
    create({ testId: "run:L01:1", email: RECIPIENT, ...PRINTER });
    at(7_000);
    expect(notifications(helpdesk, "run:L01:1")).toEqual([
      expect.objectContaining({ kind: "incident_reply", status: "skipped" }),
    ]);
    expect(resend.emails.size).toBe(0);
  });

  it("faults: a forced kind, a dropped row, and a send despite the list", () => {
    helpdesk = withEmails({
      notificationKind: (id) => (id.endsWith(":L07:1") ? "incident_reply" : "needs_info"),
      omitNotification: (id) => id.endsWith(":L07:2"),
      sentWhenNotAllowListed: (id) => id.endsWith(":S01:1"),
    });
    create({ testId: "run:L07:1", email: RECIPIENT, ...VAGUE });
    create({ testId: "run:L07:2", email: RECIPIENT, ...VAGUE });
    create({ testId: "run:S01:1", email: "canary+run1234@example.com", ...VAGUE });
    at(6_000);
    expect(notifications(helpdesk, "run:L07:1")).toEqual([
      expect.objectContaining({ kind: "incident_reply" }),
    ]);
    expect(notifications(helpdesk, "run:L07:2")).toEqual([]);
    expect(notifications(helpdesk, "run:S01:1")).toEqual([
      expect.objectContaining({ kind: "needs_info", status: "sent" }),
    ]);
    expect(resend.emails.size).toBe(2);
  });
});
