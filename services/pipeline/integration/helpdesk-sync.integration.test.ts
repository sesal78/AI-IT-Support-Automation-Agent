import { randomUUID } from "node:crypto";
import { ServiceNowConnector, createServiceNowClient } from "@ai-it-support/helpdesk";
import { ASSIGNMENT_GROUPS, type TicketStatus } from "@ai-it-support/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createPipelineAlert } from "../src/pipeline-alert.js";
import {
  createHelpdeskSyncDeps,
  onHelpdeskSyncFailure,
  runHelpdeskSync,
  type HelpdeskSyncDeps,
} from "../src/trigger/helpdesk-sync.js";
import { egress } from "../test-support/egress.js";
import {
  DEFAULT_CALLER,
  SERVICENOW_ENV,
  SERVICENOW_HOST,
  SERVICENOW_ORIGIN,
  SYS_USER_LOOKUP_PATH,
  mockServiceNow,
  type ServiceNowMock,
} from "../test-support/servicenow-mock.js";
import {
  eventTypes,
  quiet,
  requestsTo,
  sql,
  testEnv,
  testRepos,
  ticketStatus,
  useTriageStack,
} from "./triage-harness.js";

// P5-T5a: helpdesk-sync on the local REST stack (migrations 0001-0008). The real
// repositories and the real ServiceNow client and connector run; ServiceNow is
// the in-memory Table API of test-support/servicenow-mock.ts, behind the egress
// recorder (the setup file checks every test for leaked PII). wait.for and the
// clock are fake. A seeded ticket has no events, so a ticket's events are the
// events after `auto`.

useTriageStack();

let snow: ServiceNowMock;
const REQUESTER_USER = "c".repeat(32);

beforeEach(async () => {
  snow = mockServiceNow(egress);
  await sql().query("delete from itsupport.security_events where kind like 'alert:%'");
});

// ---- Seeding -----------------------------------------------------------------------

const PATHS: Partial<Record<TicketStatus, TicketStatus[]>> = {
  redacted: ["redacted"],
  triaged: ["redacted", "triaged"],
  auto: ["redacted", "triaged", "auto"],
  review_pending: ["redacted", "triaged", "review_pending"],
  approved: ["redacted", "triaged", "review_pending", "approved"],
  rejected: ["redacted", "triaged", "review_pending", "rejected"],
  escalated_manual: ["redacted", "triaged", "review_pending", "escalated_manual"],
  failed: ["failed"],
};

interface Seed {
  status?: TicketStatus;
  isTest?: boolean;
  /** The requester has a sys_user in the mock. Default true. */
  known?: boolean;
}

async function seedKbArticleId(): Promise<string> {
  const { rows } = await sql().query("select id from itsupport.kb_articles order by slug limit 1");
  return (rows[0] as { id: string }).id;
}

/** A triaged ticket in the given status, with raw text and requester data forbidden to leave. */
async function seed({ status = "auto", isTest = false, known = true }: Seed = {}) {
  const suffix = randomUUID().slice(0, 8);
  const raw = {
    title: `RAW-TITLE-${suffix}`,
    description: `RAW-DESCRIPTION-${suffix}`,
    name: `Sync Requester ${suffix}`,
    email: `sync.${suffix}@example.test`,
  };
  for (const value of Object.values(raw)) {
    egress.forbid(value);
  }
  // The email may be in the sys_user lookup query, nowhere else.
  egress.allowInQuery(SERVICENOW_ORIGIN, SYS_USER_LOOKUP_PATH, raw.email);
  const repos = testRepos();
  const { ticket } = await repos.createTicket({
    source: "web",
    raw_title: raw.title,
    raw_description: raw.description,
    requester_email: raw.email,
    requester_name: raw.name,
    department: "Finance",
    idempotency_key: `it-sync-${suffix}`,
    is_test: isTest,
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
  const kbId = await seedKbArticleId();
  await repos.saveTriageResult(ticket.id, {
    category: "hardware",
    subcategory: null,
    priority: "P3",
    urgency: "medium",
    assignmentGroup: "Hardware",
    route: "auto",
    probabilities: { hardware: 0.9 },
    flags: [],
    groundingScore: 0.9,
    kbArticleIds: [kbId],
    suggestedFix: { steps: ["Open the rear cover", "Remove the jammed paper"], caveats: [] },
    modelVersions: { llm: "test" },
  });
  for (const next of PATHS[status] ?? []) await repos.setTicketStatus(ticket.id, next);
  snow.groups.push(
    ...ASSIGNMENT_GROUPS.map((name, i) => ({ sys_id: `${i + 1}`.repeat(32), name })),
  );
  if (known) snow.users.push({ sys_id: REQUESTER_USER, email: raw.email });
  return { ticketId: ticket.id, createdAt: ticket.created_at, raw };
}

// ---- Deps --------------------------------------------------------------------------

interface DepsOptions {
  shadow?: boolean;
  e2e?: boolean;
  /** Called with the ticket's status each time the task waits. */
  onWait?: (minutes: number) => Promise<void>;
  startAt?: number;
}

function harness(options: DepsOptions = {}) {
  const env = {
    ...testEnv(),
    ...SERVICENOW_ENV,
    SHADOW_MODE: options.shadow ? "true" : "false",
    E2E_MODE: options.e2e ? "true" : "false",
  };
  let clock = options.startAt ?? Date.now();
  const waits: number[] = [];
  const real = createHelpdeskSyncDeps(env);
  const deps: HelpdeskSyncDeps = {
    ...real,
    // A short timeout, so a lost response ends the attempt quickly.
    createConnector: () =>
      new ServiceNowConnector({
        client: createServiceNowClient({
          instanceUrl: env.SERVICENOW_INSTANCE_URL,
          username: env.SERVICENOW_USERNAME,
          password: env.SERVICENOW_PASSWORD,
          timeoutMs: 300,
        }),
        defaultCaller: DEFAULT_CALLER,
      }),
    wait: {
      for: async ({ minutes }) => {
        waits.push(minutes);
        clock += minutes * 60_000;
        await options.onWait?.(minutes);
      },
    },
    now: () => clock,
    alert: createPipelineAlert(env, testRepos(), { logger: { error: () => undefined } }),
    logger: quiet,
  };
  return { deps, waits };
}

const sync = (
  ticketId: string,
  deps: HelpdeskSyncDeps,
  attempt = 1,
  testOverrides?: Record<string, unknown>,
) => runHelpdeskSync({ ticketId, ...(testOverrides ? { testOverrides } : {}) }, deps, attempt);

async function alertRows(kind: string) {
  const { rows } = await sql().query(
    "select source, kind, count from itsupport.security_events where source = 'pipeline' and kind = $1",
    [`alert:${kind}`],
  );
  return rows as Array<{ source: string; kind: string; count: number }>;
}

async function stored(ticketId: string) {
  const { rows } = await sql().query(
    "select servicenow_sys_id, servicenow_number from itsupport.tickets where id = $1",
    [ticketId],
  );
  return rows[0] as { servicenow_sys_id: string | null; servicenow_number: string | null };
}

const snowRequests = () => requestsTo(SERVICENOW_HOST);
const writes = () => snowRequests().filter((r) => r.method === "POST" || r.method === "PATCH");

async function eventPayloads(ticketId: string, type: string): Promise<unknown[]> {
  const { rows } = await sql().query(
    "select payload from itsupport.ticket_events where ticket_id = $1 and type = $2 order by id",
    [ticketId, type],
  );
  return rows.map((row: { payload: unknown }) => row.payload);
}

// ---- Tests -------------------------------------------------------------------------

describe("helpdesk-sync on the local REST stack", () => {
  it("does not resend a saved note after its PATCH reply is lost", async () => {
    const { ticketId } = await seed();
    const { deps } = harness();
    snow.fail("PATCH incident", "lose-response");
    await expect(sync(ticketId, deps)).rejects.toMatchObject({ code: "unavailable" });
    await sync(ticketId, deps, 2);
    await sync(ticketId, deps, 3);
    expect(snow.notes).toHaveLength(1);
    expect(writes().filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect(await eventPayloads(ticketId, "helpdesk_note_unconfirmed")).toEqual([
      { externalId: "1".padStart(32, "0") },
    ]);
    expect(await eventPayloads(ticketId, "helpdesk_note_added")).toEqual([]);
    expect(await alertRows("helpdesk_note_unconfirmed")).toEqual([
      { source: "pipeline", kind: "alert:helpdesk_note_unconfirmed", count: 1 },
    ]);
    expect(await ticketStatus(ticketId)).toBe("incident_created");
  });
  it.each(["auto", "approved"] as const)(
    "T5.I.01: an %s ticket ends incident_created; one incident POST, one work-note PATCH",
    async (status) => {
      const { ticketId } = await seed({ status });
      const { deps } = harness();

      await expect(sync(ticketId, deps)).resolves.toMatchObject({
        incident: { number: "INC0000001" },
      });

      expect(await ticketStatus(ticketId)).toBe("incident_created");
      expect(await stored(ticketId)).toEqual({
        servicenow_sys_id: "1".padStart(32, "0"),
        servicenow_number: "INC0000001",
      });
      expect(await eventTypes(ticketId)).toEqual([
        "helpdesk_sync_started",
        "incident_created",
        "helpdesk_note_attempted",
        "helpdesk_note_added",
      ]);
      expect(writes().map((r) => r.method)).toEqual(["POST", "PATCH"]);
      expect(snow.incidents).toHaveLength(1);
      expect(snow.incidents[0]).toMatchObject({
        caller_id: REQUESTER_USER,
        category: "hardware",
        correlation_id: ticketId,
        correlation_display: expect.stringMatching(/^ITS-\d{6}$/),
      });
      expect(snow.incidents[0]?.work_notes).toContain("Category: hardware");
    },
  );

  it("T5.I.01 privacy: the requester email is only in the sys_user lookup; no raw text anywhere", async () => {
    const { ticketId, raw } = await seed();
    await sync(ticketId, harness().deps);

    const lookups = snowRequests().filter((r) => decodeURIComponent(r.query).includes(raw.email));
    expect(lookups.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${SYS_USER_LOOKUP_PATH}`]);
    const postBody = JSON.parse(writes()[0]?.body ?? "{}") as Record<string, string>;
    expect(Object.keys(postBody).sort()).toEqual(
      [
        "assignment_group",
        "caller_id",
        "category",
        "correlation_display",
        "correlation_id",
        "description",
        "impact",
        "short_description",
        "urgency",
      ].sort(),
    );
    const { rows } = await sql().query(
      "select payload::text as p from itsupport.ticket_events where ticket_id = $1",
      [ticketId],
    );
    const everything = JSON.stringify([snowRequests().map((r) => r.body), rows]);
    for (const marker of [raw.title, raw.description, raw.name]) {
      expect(everything).not.toContain(marker);
    }
    expect(everything).not.toContain(raw.email);
  });

  it("writes caller_defaulted and uses the default caller for an unknown requester", async () => {
    const { ticketId } = await seed({ known: false });
    await sync(ticketId, harness().deps);
    expect(await eventTypes(ticketId)).toEqual([
      "helpdesk_sync_started",
      "caller_defaulted",
      "incident_created",
      "helpdesk_note_attempted",
      "helpdesk_note_added",
    ]);
    expect(snow.incidents[0]?.caller_id).toBe(DEFAULT_CALLER);
  });

  it("T5.I.02: a lost create response is found by the retry; one incident, incident_created once", async () => {
    const { ticketId } = await seed();
    const { deps } = harness();
    snow.fail("POST incident", "lose-response");

    await expect(sync(ticketId, deps, 1)).rejects.toMatchObject({ code: "unavailable" });
    expect(snow.incidents).toHaveLength(1);
    expect(await ticketStatus(ticketId)).toBe("helpdesk_pending");

    await sync(ticketId, deps, 2);

    expect(snow.incidents).toHaveLength(1);
    expect(writes().filter((r) => r.method === "POST")).toHaveLength(1);
    expect(await ticketStatus(ticketId)).toBe("incident_created");
    expect(await stored(ticketId)).toMatchObject({ servicenow_number: "INC0000001" });
    expect((await eventTypes(ticketId)).filter((t) => t === "incident_created")).toHaveLength(1);
    expect(await eventTypes(ticketId)).toEqual([
      "helpdesk_sync_started",
      "incident_created",
      "helpdesk_note_attempted",
      "helpdesk_note_added",
    ]);
  });

  it.each([401, 403])(
    "T5.I.03: ServiceNow %i fails the ticket with auth, one alert, and no retry",
    async (status) => {
      const { ticketId } = await seed();
      snow.fail("GET incident", { status });

      await expect(sync(ticketId, harness().deps)).resolves.toEqual({
        ticketId,
        failed: true,
        error: "auth",
      });

      expect(await ticketStatus(ticketId)).toBe("failed");
      expect(await eventPayloads(ticketId, "helpdesk_sync_failed")).toEqual([{ error: "auth" }]);
      expect(await alertRows("helpdesk_auth_failed")).toEqual([
        { source: "pipeline", kind: "alert:helpdesk_auth_failed", count: 1 },
      ]);
      expect(snowRequests().filter((r) => r.path.endsWith("/incident"))).toHaveLength(1);
    },
  );

  it.each([
    ["a 500", { status: 500 }],
    ["a timeout", "timeout"],
  ] as const)(
    "T5.I.03: %s on every try: 3 attempts, then onFailure sets failed",
    async (_name, fault) => {
      const { ticketId } = await seed();
      const { deps } = harness();
      snow.fail("GET incident", fault, fault, fault);

      let lastError: unknown;
      for (const attempt of [1, 2, 3]) {
        lastError = await sync(ticketId, deps, attempt).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(lastError).toMatchObject({ code: "unavailable" });
      }
      expect(await ticketStatus(ticketId)).toBe("helpdesk_pending");
      expect(writes()).toHaveLength(0);

      await onHelpdeskSyncFailure(
        { payload: { ticketId }, error: lastError },
        { repos: testRepos(), alert: deps.alert, logger: quiet },
      );

      expect(await ticketStatus(ticketId)).toBe("failed");
      expect(await eventPayloads(ticketId, "helpdesk_sync_failed")).toEqual([
        { error: "unavailable" },
      ]);
      expect(await alertRows("helpdesk_sync_failed")).toEqual([
        { source: "pipeline", kind: "alert:helpdesk_sync_failed", count: 1 },
      ]);
    },
  );

  it("T5.I.03: a 500 then success ends incident_created on the second attempt", async () => {
    const { ticketId } = await seed();
    const { deps } = harness();
    snow.fail("GET incident", { status: 500 });

    await expect(sync(ticketId, deps, 1)).rejects.toMatchObject({ code: "unavailable" });
    await expect(sync(ticketId, deps, 2)).resolves.toMatchObject({
      incident: { number: "INC0000001" },
    });

    expect(await ticketStatus(ticketId)).toBe("incident_created");
    expect(snow.incidents).toHaveLength(1);
    expect(await alertRows("helpdesk_sync_failed")).toEqual([]);
  });

  it.each(["rejected", "escalated_manual", "review_pending", "triaged", "failed"] as const)(
    "T5.I.05: a forged trigger for a %s ticket is refused, with no ServiceNow request",
    async (status) => {
      const { ticketId } = await seed({ status });

      await expect(sync(ticketId, harness().deps)).resolves.toEqual({ ticketId, refused: true });

      expect(snowRequests()).toHaveLength(0);
      expect(await ticketStatus(ticketId)).toBe(status);
      expect(await eventPayloads(ticketId, "sync_refused")).toEqual([{ status }]);
      expect(await alertRows("sync_refused")).toEqual([
        { source: "pipeline", kind: "alert:sync_refused", count: 1 },
      ]);
    },
  );

  it("a finished ticket is skipped: a second run makes no request and no event", async () => {
    const { ticketId } = await seed();
    const { deps } = harness();
    await sync(ticketId, deps);
    const requests = snowRequests().length;
    const events = await eventTypes(ticketId);

    await expect(sync(ticketId, deps)).resolves.toEqual({ ticketId, skipped: true });

    expect(snowRequests()).toHaveLength(requests);
    expect(await eventTypes(ticketId)).toEqual(events);
  });
});

describe("helpdesk-sync: the instance is asleep", () => {
  it("waits 1 then 2 minutes with helpdesk_pending in between, then creates the incident", async () => {
    const { ticketId } = await seed();
    const seen: string[] = [];
    const { deps, waits } = harness({
      onWait: async () => void seen.push(await ticketStatus(ticketId)),
    });
    snow.fail("GET incident", "asleep", "asleep");

    await sync(ticketId, deps);

    expect(waits).toEqual([1, 2]);
    expect(seen).toEqual(["helpdesk_pending", "helpdesk_pending"]);
    expect(await eventPayloads(ticketId, "helpdesk_asleep")).toEqual([
      { attempt: 1 },
      { attempt: 2 },
    ]);
    expect(await ticketStatus(ticketId)).toBe("incident_created");
    expect(snow.incidents).toHaveLength(1);
  });

  it("gives up 6 hours after the first answer: failed with asleep and one timeout alert", async () => {
    const { ticketId } = await seed();
    const { deps, waits } = harness();
    snow.setAsleep(true);

    await expect(sync(ticketId, deps)).resolves.toEqual({
      ticketId,
      failed: true,
      error: "asleep",
    });

    expect(waits).toEqual([1, 2, 4, 8, 15, 30, 60, 60, 60, 60, 60]);
    expect(await ticketStatus(ticketId)).toBe("failed");
    expect(await eventPayloads(ticketId, "helpdesk_sync_failed")).toEqual([{ error: "asleep" }]);
    expect(await alertRows("helpdesk_asleep_timeout")).toEqual([
      { source: "pipeline", kind: "alert:helpdesk_asleep_timeout", count: 1 },
    ]);
    expect(snow.incidents).toHaveLength(0);
  });

  it("helpdeskAsleepMinutes: 3 on an e2e test ticket: no request until 3 minutes after created_at", async () => {
    const { ticketId, createdAt } = await seed({ isTest: true });
    const requestsAtWait: number[] = [];
    const { deps, waits } = harness({
      e2e: true,
      startAt: Date.parse(createdAt),
      onWait: async () => void requestsAtWait.push(snowRequests().length),
    });

    await sync(ticketId, deps, 1, { helpdeskAsleepMinutes: 3 });

    expect(waits).toEqual([1, 2]);
    expect(requestsAtWait).toEqual([0, 0]);
    expect(await ticketStatus(ticketId)).toBe("incident_created");
    expect(snow.incidents[0]?.short_description).toMatch(/^\[E2E\] /);
  });

  it.each([
    ["is_test = false", { isTest: false, e2e: true }],
    ["E2E_MODE=false", { isTest: true, e2e: false }],
  ])("helpdeskAsleepMinutes has no effect with %s", async (_name, { isTest, e2e }) => {
    const { ticketId, createdAt } = await seed({ isTest });
    const { deps, waits } = harness({ e2e, startAt: Date.parse(createdAt) });

    await sync(ticketId, deps, 1, { helpdeskAsleepMinutes: 3 });

    expect(waits).toEqual([]);
    expect(await ticketStatus(ticketId)).toBe("incident_created");
  });
});

describe("helpdesk-sync: shadow mode", () => {
  it.each([
    ["SHADOW_MODE=true", { shadow: true }, undefined],
    ["the shadowMode switch on an e2e test ticket", { e2e: true }, { shadowMode: true }],
  ] as Array<[string, DepsOptions, Record<string, unknown> | undefined]>)(
    "%s: incident_skipped_shadow, no POST and no PATCH",
    async (_name, options, overrides) => {
      const { ticketId } = await seed({ isTest: options.e2e === true });

      await expect(sync(ticketId, harness(options).deps, 1, overrides)).resolves.toEqual({
        ticketId,
        shadow: true,
      });

      expect(await ticketStatus(ticketId)).toBe("incident_skipped_shadow");
      expect(await eventTypes(ticketId)).toEqual(["helpdesk_sync_started", "shadow_skipped"]);
      expect(await eventPayloads(ticketId, "shadow_skipped")).toEqual([{ operation: "create" }]);
      expect(writes()).toHaveLength(0);
      expect(snow.incidents).toHaveLength(0);
      expect(await stored(ticketId)).toEqual({ servicenow_sys_id: null, servicenow_number: null });
    },
  );
});
