// A mock of the e2e app's phase 5 flow (test support only): redacted ->
// triaged -> auto | review -> helpdesk_pending -> incident_created, plus the
// incident the `helpdesk-sync` task would create. It writes that incident into
// the same in-memory Table API data the P5-T7 helper reads, so a scenario sees
// real rows: category, caller, assignment group, correlation_display and the
// triage work note.
import { randomUUID } from "node:crypto";
import { redact } from "@ai-it-support/shared";
import { E2E_PREFIX } from "../servicenow.ts";
import type { MockReply, MockRequest } from "./mock-e2e.ts";
import { groupSysId, snStamp, sysId, type MockSnData } from "./mock-servicenow.ts";

/** Ways the mock can misbehave, so each scenario's negative cases can be shown. */
export interface MockHelpdeskFaults {
  /** Sync start -> incident, in ms (default 1 000). */
  readonly incidentAfterMs?: (testId: string) => number;
  /** The incident's `category` instead of the triage category (T5.L.01). */
  readonly category?: (testId: string) => string;
  /** The incident's `caller_id` instead of the persona lookup (T5.L.01). */
  readonly caller?: (testId: string) => string;
  /** How many incidents to create for one ticket (default 1, T5.L.03). */
  readonly incidents?: (testId: string) => number;
  /** How many work notes to write (default 1, T5.L.01). */
  readonly workNotes?: (testId: string) => number;
  /** The incident's `correlation_display` instead of the ticket number. */
  readonly correlationDisplay?: (testId: string) => string;
  /** The incident's `assignment_group` name instead of the triage group (T5.L.08). */
  readonly assignmentGroup?: (testId: string) => string;
  /** The triage route instead of the text's (T5.L.02: a live triage miss). */
  readonly route?: (testId: string) => "auto" | "review";
  /** Writes no `helpdesk_asleep` event (T5.F.01 negative). */
  readonly asleepWithoutEvent?: boolean;
  /** Wakes the instance this much later than the override says (T5.F.01 negative). */
  readonly asleepExtraMs?: (testId: string) => number;
  /** Adds one incident with a correlation_id no ticket owns (T5.O.01 negative). */
  readonly orphan?: (testId: string) => boolean;
  /** Creates the incident although the ticket is in shadow mode (T5.L.05 negative). */
  readonly createInShadow?: boolean;
  /** Creates an incident for a rejected or timed-out ticket (T5.L.04 negative). */
  readonly syncRejected?: (testId: string) => boolean;
}

export interface MockHelpdeskOptions {
  readonly now: () => number;
  /** Where created incidents and work notes go; the scenario reads this data. */
  readonly data: MockSnData;
  /** The channel a signed decision must name; any channel when unset. */
  readonly channelId?: string;
  /** The 2-minute review timeout of the e2e app (H14). */
  readonly reviewTimeoutMs?: number;
  readonly faults?: MockHelpdeskFaults;
}

interface MockTriage {
  readonly category: string;
  readonly assignmentGroup: string;
  readonly route: "auto" | "review";
  readonly sensitiveFlags: readonly string[];
}

/** A ticket the mock app is holding, with the time of each step. */
export interface MockHelpdeskTicket {
  readonly testId: string;
  readonly ticketId: string;
  readonly number: string;
  readonly createdAt: number;
  readonly title: string;
  readonly description: string;
  readonly email: string;
  readonly triage: MockTriage;
  readonly shadowMode: boolean;
  readonly reviewTimeoutMs: number;
  /** From `testOverrides.helpdeskAsleepMinutes`: the instance sleeps this long. */
  readonly asleepMinutes: number | null;
  status: string;
  events: Array<{ type: string; at: number }>;
  review: {
    id: string;
    slackTs: string;
    createdAt: number;
    decision: "approve" | "reject" | "timeout" | null;
    decidedBy: string | null;
    decidedAt: number | null;
  } | null;
  reviewPendingAt: number | null;
  syncAt: number | null;
  syncStartedAt: number | null;
  pendingDecision: { decision: "approve" | "reject"; at: number } | null;
  asleepAttempts: number;
  incident: { number: string; sysId: string } | null;
}

export interface MockHelpdesk {
  readonly override: (request: MockRequest) => MockReply | undefined;
  /** Tickets by test ID. */
  readonly tickets: Map<string, MockHelpdeskTicket>;
  /** Moves the tickets on to the mock clock's time. */
  tick(): void;
}

export const REDACT_MS = 1_000;
export const TRIAGE_MS = 5_000;
/** Triaged or approved -> `helpdesk_pending`. */
export const SYNC_DELAY_MS = 1_000;
/** `helpdesk_pending` -> incident (the sync's one write). */
export const INCIDENT_MS = 1_000;
/** Triaged -> a card ts for a review ticket. */
export const REVIEW_DELAY_MS = 1_000;
/** A recorded click -> `review_decided` and the status (the woken run). */
export const DECISION_LAG_MS = 500;
/** The e2e review timeout, H14. */
export const REVIEW_TIMEOUT_MS = 120_000;

const INTERACTIVITY = "/api/slack/interactivity";
const NO_STORE = { "Cache-Control": "no-store" };
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * What the mock triage decides from the ticket text: a printer, screen or
 * laptop fault is `hardware` on the `auto` route; an HR complaint is sensitive
 * and goes to `review`; anything else is `software` on the `auto` route. The
 * real app uses the model (P3-T2); this is the deterministic stand-in.
 */
export function defaultHelpdeskTriage(title: string, description: string): MockTriage {
  const text = `${title} ${description}`;
  if (/\bHR\b|harassment|complaint/i.test(text)) {
    return {
      category: "software",
      assignmentGroup: "Software",
      route: "review",
      sensitiveFlags: ["hr"],
    };
  }
  if (/printer|monitor|screen|laptop|keyboard|docking/i.test(text)) {
    return { category: "hardware", assignmentGroup: "Hardware", route: "auto", sensitiveFlags: [] };
  }
  return { category: "software", assignmentGroup: "Software", route: "auto", sensitiveFlags: [] };
}

/** The `sys_id` of the active user with this email, or of `svc.itsupport`. */
export function mockCallerId(data: MockSnData, email: string): string {
  const found = data.users.find((u) => u["email"] === email && u["active"] !== "false");
  if (found !== undefined) return found["sys_id"]!;
  return data.users.find((u) => u["user_name"] === "svc.itsupport")?.["sys_id"] ?? sysId(1);
}

export function createMockHelpdesk(options: MockHelpdeskOptions): MockHelpdesk {
  const { now, data, faults = {} } = options;
  const tickets = new Map<string, MockHelpdeskTicket>();
  let seq = 1;

  const ticketById = (id: string) => [...tickets.values()].find((t) => t.ticketId === id);
  const push = (t: MockHelpdeskTicket, type: string, at: number) => t.events.push({ type, at });

  /** Creates `count` incidents for the ticket at `at`, like the connector. */
  function createIncidents(t: MockHelpdeskTicket, at: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const n = data.incidents.length + 1;
      const row: Record<string, string> = {
        sys_id: sysId(900 + n),
        number: `INC${String(n).padStart(7, "0")}`,
        category: faults.category?.(t.testId) ?? t.triage.category,
        caller_id: faults.caller?.(t.testId) ?? mockCallerId(data, t.email),
        assignment_group:
          groupSysId(data, faults.assignmentGroup?.(t.testId) ?? t.triage.assignmentGroup) ?? "",
        short_description: `${E2E_PREFIX} ${t.title}`,
        description: t.description,
        state: "1",
        correlation_id: t.ticketId,
        correlation_display: faults.correlationDisplay?.(t.testId) ?? t.number,
        sys_created_on: snStamp(at),
      };
      data.incidents.push(row);
      if (i === 0) t.incident = { number: row["number"]!, sysId: row["sys_id"]! };
      // The triage work note (DoD 5); its text carries no ticket text.
      for (let note = 0; note < (faults.workNotes?.(t.testId) ?? 1); note++) {
        data.journal.push({
          element_id: row["sys_id"]!,
          element: "work_notes",
          value: `Triage note: category ${row["category"]}, priority P3.`,
        });
      }
    }
  }

  /** Adds one incident with a correlation_id no ticket owns, at `at`. */
  function createOrphan(at: number): void {
    const n = data.incidents.length + 1;
    data.incidents.push({
      sys_id: sysId(900 + n),
      number: `INC${String(n).padStart(7, "0")}`,
      category: "software",
      caller_id: sysId(1),
      assignment_group: "",
      short_description: `${E2E_PREFIX} orphan`,
      description: "Orphan incident",
      state: "1",
      correlation_id: randomUUID(),
      correlation_display: `ITS-${String(n).padStart(6, "0")}`,
      sys_created_on: snStamp(at),
    });
  }

  /** Moves every ticket on to `at`, writing each step at its own time. */
  function advance(at: number): void {
    for (const t of tickets.values()) {
      const redactedAt = t.createdAt + REDACT_MS;
      if (t.status === "new" && at >= redactedAt) {
        t.status = "redacted";
        push(t, "redacted", redactedAt);
      }

      const triagedAt = t.createdAt + TRIAGE_MS;
      if (t.status === "redacted" && at >= triagedAt) {
        push(t, "policy_decided", triagedAt);
        push(t, "triaged", triagedAt);
        if (t.triage.route === "review") {
          const pendingAt = triagedAt + REVIEW_DELAY_MS;
          t.review = {
            id: randomUUID(),
            slackTs: `${Math.floor(pendingAt / 1000)}.${String(seq++).padStart(6, "0")}`,
            createdAt: pendingAt,
            decision: null,
            decidedBy: null,
            decidedAt: null,
          };
          t.reviewPendingAt = pendingAt;
          push(t, "review_requested", pendingAt);
          t.status = "review_pending";
        } else {
          t.status = "auto";
          t.syncAt = triagedAt + SYNC_DELAY_MS;
        }
      }

      // No decision in time: the app escalates the ticket to the manual queue.
      if (
        t.status === "review_pending" &&
        t.review !== null &&
        t.review.decision === null &&
        t.reviewPendingAt !== null &&
        at >= t.reviewPendingAt + t.reviewTimeoutMs
      ) {
        const timeoutAt = t.reviewPendingAt + t.reviewTimeoutMs;
        t.review.decision = "timeout";
        t.review.decidedAt = timeoutAt;
        push(t, "review_timed_out", timeoutAt);
        t.status = "escalated_manual";
      }

      // A recorded click: review_decided and the new status 500 ms later.
      if (t.pendingDecision !== null && at >= t.pendingDecision.at) {
        const { decision, at: decidedAt } = t.pendingDecision;
        t.pendingDecision = null;
        t.review!.decision = decision;
        t.review!.decidedAt = decidedAt;
        push(t, "review_decided", decidedAt);
        t.status = decision === "approve" ? "approved" : "rejected";
        if (decision === "approve") t.syncAt = decidedAt + SYNC_DELAY_MS;
      }

      // Neither a rejected nor a timed-out ticket starts the sync.
      if (
        (t.status === "rejected" || t.status === "escalated_manual") &&
        t.incident === null &&
        faults.syncRejected?.(t.testId) === true
      ) {
        createIncidents(t, at, 1);
      }

      if ((t.status === "auto" || t.status === "approved") && t.syncAt !== null && at >= t.syncAt) {
        t.status = "helpdesk_pending";
        t.syncStartedAt = t.syncAt;
        push(t, "helpdesk_sync_started", t.syncAt);
      }
      if (t.status !== "helpdesk_pending" || t.syncStartedAt === null) continue;

      // While the instance sleeps, the ticket waits at helpdesk_pending and the
      // sync writes helpdesk_asleep on each attempt (resolved point 9).
      if (t.asleepMinutes !== null) {
        const wakeAt =
          t.createdAt + t.asleepMinutes * 60_000 + (faults.asleepExtraMs?.(t.testId) ?? 0);
        let attempts = t.asleepAttempts;
        for (
          let attemptAt = t.syncStartedAt + attempts * 60_000;
          attemptAt < wakeAt && attemptAt <= at;
          attemptAt += 60_000
        ) {
          attempts += 1;
          if (faults.asleepWithoutEvent !== true) push(t, "helpdesk_asleep", attemptAt);
        }
        t.asleepAttempts = attempts;
        const incidentAt = wakeAt + INCIDENT_MS;
        if (at < incidentAt) continue;
        createIncidents(t, incidentAt, faults.incidents?.(t.testId) ?? 1);
        if (faults.orphan?.(t.testId) === true) createOrphan(incidentAt);
        push(t, "incident_created", incidentAt);
        push(t, "helpdesk_note_added", incidentAt);
        t.status = "incident_created";
        continue;
      }

      const doneAt = t.syncStartedAt + (faults.incidentAfterMs?.(t.testId) ?? INCIDENT_MS);
      if (at < doneAt) continue;
      if (t.shadowMode) {
        if (faults.createInShadow === true) createIncidents(t, doneAt, 1);
        push(t, "shadow_skipped", doneAt);
        t.status = "incident_skipped_shadow";
      } else {
        createIncidents(t, doneAt, faults.incidents?.(t.testId) ?? 1);
        if (faults.orphan?.(t.testId) === true) createOrphan(doneAt);
        push(t, "incident_created", doneAt);
        push(t, "helpdesk_note_added", doneAt);
        t.status = "incident_created";
      }
    }
  }

  function create(body: Record<string, unknown>): MockReply {
    const testId = typeof body.testId === "string" ? body.testId : "";
    const existing = tickets.get(testId);
    if (existing) {
      return {
        status: 201,
        json: {
          ticketId: existing.ticketId,
          ticketNumber: existing.number,
          queued: true,
          duplicate: true,
        },
      };
    }
    const overrides = (body.testOverrides ?? {}) as {
      shadowMode?: unknown;
      helpdeskAsleepMinutes?: unknown;
    };
    const title = redact(String(body.title)).text;
    const description = redact(String(body.description)).text;
    const triage = defaultHelpdeskTriage(title, description);
    const ticket: MockHelpdeskTicket = {
      testId,
      ticketId: randomUUID(),
      number: `ITS-${String(tickets.size + 1).padStart(6, "0")}`,
      createdAt: now(),
      title,
      description,
      email: String(body.email ?? ""),
      triage: { ...triage, route: faults.route?.(testId) ?? triage.route },
      shadowMode: overrides.shadowMode === true,
      reviewTimeoutMs: options.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS,
      asleepMinutes:
        typeof overrides.helpdeskAsleepMinutes === "number"
          ? overrides.helpdeskAsleepMinutes
          : null,
      status: "new",
      events: [],
      review: null,
      reviewPendingAt: null,
      syncAt: null,
      syncStartedAt: null,
      pendingDecision: null,
      asleepAttempts: 0,
      incident: null,
    };
    tickets.set(testId, ticket);
    return {
      status: 201,
      json: { ticketId: ticket.ticketId, ticketNumber: ticket.number, queued: true },
    };
  }

  function view(t: MockHelpdeskTicket) {
    const triaged = t.events.some((e) => e.type === "triaged");
    return {
      id: t.ticketId,
      number: t.number,
      status: t.status,
      isTest: true,
      source: "web",
      createdAt: iso(t.createdAt),
      redacted: t.status === "new" ? null : { title: t.title, description: t.description },
      triage: triaged
        ? {
            sensitive: t.triage.sensitiveFlags.length > 0,
            sensitiveFlags: [...t.triage.sensitiveFlags],
            category: t.triage.category,
            subcategory: null,
            priority: "P3",
            urgency: "medium",
            assignmentGroup: t.triage.assignmentGroup,
            route: t.triage.route,
            flags: [],
            probabilities: null,
            groundingScore: 0.9,
            kbArticleIds: [],
            suggestedFix: { steps: ["step 1", "step 2"], caveats: [] },
            modelVersions: null,
            triagedAt: iso(t.createdAt + TRIAGE_MS),
          }
        : null,
      aiCallCount: triaged ? 1 : 0,
      events: t.events.map((e) => ({ type: e.type, at: iso(e.at) })),
      reviews:
        t.review === null
          ? []
          : [
              {
                id: t.review.id,
                kind: "triage",
                decision: t.review.decision,
                decidedBy: t.review.decidedBy,
                decidedAt: t.review.decidedAt === null ? null : iso(t.review.decidedAt),
                slackTs: t.review.slackTs,
                createdAt: iso(t.review.createdAt),
              },
            ],
      notifications: [],
      autofix: [],
      incident: t.incident === null ? null : { number: t.incident.number, sysId: t.incident.sysId },
    };
  }

  /** A signed decision, answered like the app: verify, bind, record. */
  function decide(request: MockRequest, at: number): MockReply {
    if (request.slack === null || !request.slack.ok) {
      return { status: 401, json: { error: "unauthorized" }, headers: NO_STORE };
    }
    interface Payload {
      type?: unknown;
      actions?: unknown;
      user?: { id?: unknown };
      channel?: { id?: unknown };
      container?: { message_ts?: unknown };
    }
    let payload: Payload | undefined;
    try {
      payload = JSON.parse(new URLSearchParams(request.body).get("payload") ?? "") as Payload;
    } catch {
      payload = undefined;
    }
    const actions = payload?.actions;
    const action =
      Array.isArray(actions) && actions.length === 1
        ? (actions[0] as { action_id?: unknown; value?: unknown } | undefined)
        : undefined;
    const decision =
      action?.action_id === "review_approve"
        ? "approve"
        : action?.action_id === "review_reject"
          ? "reject"
          : undefined;
    const userId = payload?.user?.id;
    if (
      payload?.type !== "block_actions" ||
      decision === undefined ||
      typeof action?.value !== "string" ||
      typeof userId !== "string"
    ) {
      return { status: 400, json: { error: "bad_payload" }, headers: NO_STORE };
    }
    const ticket = [...tickets.values()].find((t) => t.review?.id === action.value);
    if (ticket === undefined)
      return { status: 404, json: { error: "not_found" }, headers: NO_STORE };
    const review = ticket.review!;
    if (
      options.channelId !== undefined &&
      (payload?.channel?.id !== options.channelId ||
        payload?.container?.message_ts !== review.slackTs)
    ) {
      return { status: 403, json: { error: "forbidden" }, headers: NO_STORE };
    }
    if (review.decision === "timeout") return { status: 200, json: { outcome: "late" } };
    if (review.decision !== null) {
      return { status: 200, json: { outcome: "already_decided" } };
    }
    review.decidedBy = userId;
    ticket.pendingDecision = { decision, at: at + DECISION_LAG_MS };
    return { status: 200, json: { outcome: "recorded" } };
  }

  function override(request: MockRequest): MockReply | undefined {
    const at = now();
    advance(at);
    if (request.method === "POST" && request.path === INTERACTIVITY) {
      return request.accessOk ? decide(request, at) : undefined;
    }
    if (!request.accessOk || !request.bearerOk) return undefined;
    if (request.method === "POST" && request.path === "/api/internal/test-tickets") {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(request.body) as Record<string, unknown>;
      } catch {
        return {
          status: 400,
          json: { error: "invalid_body" },
          headers: { "Cache-Control": "no-store" },
        };
      }
      return create(body);
    }
    const match = /^\/api\/internal\/tickets\/([^/]+)$/.exec(request.path);
    const ticket = match ? ticketById(match[1]!) : undefined;
    if (request.method === "GET" && ticket) return { status: 200, json: view(ticket) };
    return undefined;
  }

  return { override, tickets, tick: () => advance(now()) };
}
