import { randomUUID } from "node:crypto";
import {
  ASSIGNMENT_GROUPS,
  HELPDESK_SYNC_TASK_ID,
  NOTIFY_REQUESTER_TASK_ID,
  type NotificationKind,
  type TicketStatus,
} from "@ai-it-support/shared";
import { tasks } from "@trigger.dev/sdk";
import { HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { helpdeskSync } from "../src/trigger/helpdesk-sync.js";
import type { notifyRequester } from "../src/trigger/notify-requester.js";
import { egress } from "../test-support/egress.js";
import { startLocalRunner, type LocalRunner } from "../test-support/local-runner.js";
import { REPLY_ENV, REPLY_RECIPIENT, RESEND_ORIGIN } from "../test-support/provider-mocks.js";
import { SERVICENOW_ORIGIN, SYS_USER_LOOKUP_PATH } from "../test-support/servicenow-mock.js";
import {
  eventPayloads,
  eventTypes,
  requestsTo,
  sql,
  testRepos,
  testStack,
  ticketStatus,
  useTriageStack,
} from "./triage-harness.js";

// P5-T8b, T5.I.06: notify-requester on the local REST stack (migrations
// 0001-0008) through the local Trigger.dev runner and the real SDK. The real
// repositories, Resend client and tasks run; Resend is a scripted mock behind
// the egress recorder, which checks every test for leaked PII. The requester
// address may be in Resend's `to` field only (allowRecipientInBody).

useTriageStack();

const INC = "INC0010001";
const SYS_ID = "a".repeat(31) + "1";
const SEND_PATH = "/emails";
const FROM = REPLY_ENV.REPLY_FROM;

let runner: LocalRunner;

beforeAll(async () => {
  runner = await startLocalRunner({ restStack: testStack(), egress });
});

beforeEach(() => {
  vi.stubEnv("TRIGGER_API_URL", runner.url);
  vi.stubEnv("TRIGGER_SECRET_KEY", "x".repeat(32));
});

afterEach(async () => {
  await runner.idle();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await runner?.stop();
});

// ---- Seeding -----------------------------------------------------------------------

const PATHS: Partial<Record<TicketStatus, TicketStatus[]>> = {
  auto: ["redacted", "triaged", "auto"],
  incident_created: ["redacted", "triaged", "auto", "helpdesk_pending", "incident_created"],
  review_pending: ["redacted", "triaged", "review_pending"],
  rejected: ["redacted", "triaged", "review_pending", "rejected"],
};

interface Seed {
  status?: TicketStatus;
  /** Default: the one allow-listed address. */
  email?: string;
  incident?: boolean;
  flags?: string[];
  steps?: string[];
}

/** A triaged ticket with raw text and the requester address forbidden to leave. */
async function seed({
  status = "incident_created",
  email = REPLY_RECIPIENT,
  incident = true,
  flags = [],
  steps = ["Open the rear cover", "Remove the jammed paper"],
}: Seed = {}) {
  const suffix = randomUUID().slice(0, 8);
  const raw = {
    title: `RAW-TITLE-${suffix}`,
    description: `RAW-DESCRIPTION-${suffix}`,
    name: `Notify Requester ${suffix}`,
  };
  for (const value of [...Object.values(raw), email]) egress.forbid(value);
  // The address may be Resend's sole `to` entry, and the ServiceNow lookup query, nowhere else.
  egress.allowRecipientInBody(RESEND_ORIGIN, SEND_PATH, email, FROM);
  egress.allowInQuery(SERVICENOW_ORIGIN, SYS_USER_LOOKUP_PATH, email);
  const repos = testRepos();
  const { ticket } = await repos.createTicket({
    source: "web",
    raw_title: raw.title,
    raw_description: raw.description,
    requester_email: email,
    requester_name: raw.name,
    department: "Finance",
    idempotency_key: `it-notify-${suffix}`,
  });
  await repos.saveRedaction({
    ticket_id: ticket.id,
    redacted_title: "Printer on level 2 is jammed",
    redacted_description: "The printer shows a paper jam and nothing is stuck inside.",
    redaction_log: [],
  });
  await repos.saveTriage({
    ticket_id: ticket.id,
    sensitive: false,
    sensitive_flags: [],
    checker: "keywords",
  });
  await repos.saveTriageResult(ticket.id, {
    category: "hardware",
    subcategory: null,
    priority: "P3",
    urgency: "medium",
    assignmentGroup: "Hardware",
    route: flags.includes("needs_info") ? "review" : "auto",
    probabilities: { hardware: 0.9 },
    flags: flags as never,
    groundingScore: 0.9,
    kbArticleIds: [],
    suggestedFix: { steps, caveats: [] },
    modelVersions: { llm: "test" },
  });
  for (const next of PATHS[status] ?? []) await repos.setTicketStatus(ticket.id, next);
  if (incident) {
    await repos.setTicketIncident(ticket.id, { sysId: SYS_ID, number: INC });
    await repos.setTicketHelpdesk(ticket.id, "servicenow");
  }
  return { ticketId: ticket.id, ticketNumber: ticket.ticket_number, email, raw };
}

// ---- Resend script -----------------------------------------------------------------

/**
 * Resend answers the given statuses in order, then repeats the last one. A 200
 * answers the id first given for the request's Idempotency-Key, like the real API.
 */
function scriptResend(...statuses: number[]) {
  const ids = new Map<string, string>();
  let served = 0;
  egress.mock(RESEND_ORIGIN, ({ request }) => {
    const status = statuses[Math.min(served, statuses.length - 1)] ?? 200;
    served += 1;
    if (status === 200) {
      const key = request.headers.get("idempotency-key") ?? "";
      const id = ids.get(key) ?? `msg_it_${String(ids.size + 1).padStart(4, "0")}`;
      ids.set(key, id);
      return HttpResponse.json({ id });
    }
    return HttpResponse.json(
      { name: "error", message: "scripted" },
      { status, headers: status === 429 ? { "retry-after": "1" } : {} },
    );
  });
}

const emailRequests = () => requestsTo("api.resend.com");

/** Triggers one run and returns the runs it started (the runner keeps every run of the file). */
async function startNotify(ticketId: string, kind: NotificationKind = "incident_reply") {
  const before = runner.runs().length;
  await tasks.trigger<typeof notifyRequester>(NOTIFY_REQUESTER_TASK_ID, { ticketId, kind });
  await runner.idle();
  return runner.runs().slice(before);
}

async function notifications(ticketId: string) {
  const { rows } = await sql().query(
    "select kind, status, reason, provider_id from itsupport.notifications where ticket_id = $1 order by kind",
    [ticketId],
  );
  return rows as Array<{
    kind: string;
    status: string;
    reason: string | null;
    provider_id: string | null;
  }>;
}

async function alertRows(kind: string) {
  const { rows } = await sql().query(
    "select count from itsupport.security_events where source = 'pipeline' and kind = $1",
    [`alert:${kind}`],
  );
  return rows as Array<{ count: number }>;
}

beforeEach(async () => {
  await sql().query("delete from itsupport.security_events where kind like 'alert:%'");
});

// ---- Tests -------------------------------------------------------------------------

describe("notify-requester on the local REST stack", () => {
  it("sends one email with the ITS number and the INC number, records one sent row and one event, and a second run sends nothing", async () => {
    const { ticketId, ticketNumber, email } = await seed();
    scriptResend(200);

    const first = await startNotify(ticketId);

    const requests = emailRequests();
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe(SEND_PATH);
    expect(request.headers["idempotency-key"]).toBe(`notify:${ticketId}:incident_reply`);
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.to).toEqual([email]);
    expect(body.from).toBe(FROM);
    expect(body.subject).toBe(`Your IT ticket ${ticketNumber}`);
    expect(String(body.text)).toContain(INC);
    expect(String(body.text)).toContain("1. Open the rear cover");
    expect(await notifications(ticketId)).toEqual([
      { kind: "incident_reply", status: "sent", reason: null, provider_id: "msg_it_0001" },
    ]);
    expect(await eventTypes(ticketId)).toContain("notification_sent");
    expect(await eventPayloads(ticketId, "notification_sent")).toEqual([
      { kind: "incident_reply" },
    ]);
    expect(await ticketStatus(ticketId)).toBe("incident_created");

    const second = await startNotify(ticketId);
    expect(emailRequests()).toHaveLength(1);
    expect(await notifications(ticketId)).toHaveLength(1);
    expect(await eventPayloads(ticketId, "notification_sent")).toHaveLength(1);
    expect([...first, ...second].map((run) => run.status)).toEqual(["COMPLETED", "COMPLETED"]);
  });

  it("T5.I.06: Resend answers 429 and then 200: sent after 2 requests", async () => {
    const { ticketId } = await seed();
    scriptResend(429, 200);

    const runs = await startNotify(ticketId);

    const requests = emailRequests();
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.headers["idempotency-key"])).toEqual([
      `notify:${ticketId}:incident_reply`,
      `notify:${ticketId}:incident_reply`,
    ]);
    expect(await notifications(ticketId)).toMatchObject([{ status: "sent" }]);
    expect(runs).toMatchObject([{ status: "COMPLETED", attempts: 1 }]);
    expect(await alertRows("notify_failed")).toEqual([]);
  });

  it("T5.I.06: Resend always answers 500: bounded retries, then one failed row, one event, one alert, and the ticket stays incident_created", async () => {
    const { ticketId } = await seed();
    scriptResend(500);

    const runs = await startNotify(ticketId);

    // 3 task attempts, each with the client's 3 requests, all under one key.
    const requests = emailRequests();
    expect(requests).toHaveLength(9);
    expect(new Set(requests.map((r) => r.headers["idempotency-key"]))).toEqual(
      new Set([`notify:${ticketId}:incident_reply`]),
    );
    expect(runs).toMatchObject([{ status: "FAILED", attempts: 3 }]);
    expect(await notifications(ticketId)).toEqual([
      { kind: "incident_reply", status: "failed", reason: "provider_error", provider_id: null },
    ]);
    expect(await eventPayloads(ticketId, "notification_failed")).toEqual([
      { kind: "incident_reply", error: "http_500" },
    ]);
    expect(await alertRows("notify_failed")).toEqual([{ count: 1 }]);
    expect(await ticketStatus(ticketId)).toBe("incident_created");

    // A later run finds the failed row and sends nothing more.
    scriptResend(200);
    await startNotify(ticketId);
    expect(emailRequests()).toHaveLength(9);
    expect(await notifications(ticketId)).toMatchObject([{ status: "failed" }]);
  }, 90_000);

  it("a permanent 422 ends after one request and one attempt, with the failed row", async () => {
    const { ticketId } = await seed();
    scriptResend(422);

    const runs = await startNotify(ticketId);

    expect(emailRequests()).toHaveLength(1);
    expect(runs).toMatchObject([{ status: "FAILED", attempts: 1 }]);
    expect(await notifications(ticketId)).toMatchObject([{ status: "failed" }]);
    expect(await alertRows("notify_failed")).toEqual([{ count: 1 }]);
  });

  it("a requester not on the list: no request, one skipped row, one event, run completed", async () => {
    const { ticketId } = await seed({
      email: `not.listed.${randomUUID().slice(0, 8)}@example.test`,
    });
    scriptResend(200);

    const runs = await startNotify(ticketId);

    expect(emailRequests()).toEqual([]);
    expect(await notifications(ticketId)).toEqual([
      { kind: "incident_reply", status: "skipped", reason: "not_allow_listed", provider_id: null },
    ]);
    expect(await eventPayloads(ticketId, "notification_skipped")).toEqual([
      { kind: "incident_reply" },
    ]);
    expect(runs).toMatchObject([{ status: "COMPLETED" }]);
  });

  it("an incident_reply for a rejected ticket, or one with no number, aborts: no request, no row", async () => {
    const rejected = await seed({ status: "rejected", incident: false });
    const numberless = await seed({ incident: false });
    scriptResend(200);

    const runs = [
      ...(await startNotify(rejected.ticketId)),
      ...(await startNotify(numberless.ticketId)),
    ];

    expect(emailRequests()).toEqual([]);
    expect(runs.map((run) => [run.status, run.attempts])).toEqual([
      ["FAILED", 1],
      ["FAILED", 1],
    ]);
    // A refused trigger on a rejected ticket must not fill its slot.
    expect(await notifications(rejected.ticketId)).toEqual([]);
    expect(await ticketStatus(rejected.ticketId)).toBe("rejected");
  });

  it("the needs_info variant is sent once, under its own key, for a flagged ticket", async () => {
    const { ticketId, ticketNumber } = await seed({
      status: "review_pending",
      incident: false,
      flags: ["needs_info"],
    });
    scriptResend(200);

    await startNotify(ticketId, "needs_info");

    const requests = emailRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["idempotency-key"]).toBe(`notify:${ticketId}:needs_info`);
    const body = JSON.parse(requests[0]!.body) as { subject: string; text: string };
    expect(body.subject).toBe(`More detail needed for your IT ticket ${ticketNumber}`);
    expect(body.text).not.toMatch(/INC|HD0/);
    expect(await notifications(ticketId)).toMatchObject([{ kind: "needs_info", status: "sent" }]);
    expect(await ticketStatus(ticketId)).toBe("review_pending");
  });

  it("the whole flow: helpdesk-sync creates the incident and starts the reply, which is sent once", async () => {
    const own = await startLocalRunner({
      restStack: testStack(),
      egress,
      env: { SHADOW_MODE: "false" },
    });
    try {
      vi.stubEnv("TRIGGER_API_URL", own.url);
      own.serviceNow.groups.push(
        ...ASSIGNMENT_GROUPS.map((name, index) => ({ sys_id: `${index + 1}`.repeat(32), name })),
      );
      const { ticketId, ticketNumber } = await seed({ status: "auto", incident: false });
      scriptResend(200);

      await tasks.trigger<typeof helpdeskSync>(HELPDESK_SYNC_TASK_ID, { ticketId });
      await vi.waitFor(async () => expect(await notifications(ticketId)).toHaveLength(1), {
        timeout: 30_000,
        interval: 200,
      });
      await own.idle();

      expect(await ticketStatus(ticketId)).toBe("incident_created");
      expect(emailRequests()).toHaveLength(1);
      const body = JSON.parse(emailRequests()[0]!.body) as { subject: string; text: string };
      expect(body.subject).toBe(`Your IT ticket ${ticketNumber}`);
      expect(body.text).toMatch(/INC\d{7,}/);
      const types = await eventTypes(ticketId);
      expect(types.indexOf("incident_created")).toBeLessThan(types.indexOf("notification_sent"));
      expect(types.filter((type) => type === "notification_sent")).toHaveLength(1);
      expect(
        own
          .runs()
          .map((run) => [run.taskId, run.status])
          .sort(),
      ).toEqual([
        [HELPDESK_SYNC_TASK_ID, "COMPLETED"],
        [NOTIFY_REQUESTER_TASK_ID, "COMPLETED"],
      ]);
    } finally {
      await own.stop();
    }
  }, 90_000);
});
