import type { InternalTicketView } from "@ai-it-support/shared";
import { LiveContractError } from "./client.ts";
import type { Evidence, Scenario, ScenarioContext, ScenarioResult } from "./runner.ts";

/**
 * The live pipeline scenarios (plan T3.L.02, T3.L.03, T3.F.01, T3.S.04).
 * Ticket text is synthetic and stays in the request bodies: evidence carries
 * ticket IDs, times, statuses and flags only.
 */

/** Each ticket must reach `triaged` within this time of its creation. */
export const TRIAGE_LIMIT_MS = 120_000;
export const POLL_MS = 1_000;
/** DoD 4: the p95 of redacted → triaged must be under 30 s. */
export const P95_LIMIT_MS = 30_000;
export const L02_TICKETS = 20;
/** Cloudflare's dummy token; the e2e app's always-pass test keys accept any token. */
export const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/** p95 by nearest rank: the value at rank ceil(0.95 · n) of the sorted list. */
export function p95(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError("p95 of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((95 * sorted.length) / 100) - 1]!;
}

interface TicketText {
  readonly title: string;
  readonly description: string;
}

/** One synthetic ticket per category, in the order of the shared CATEGORIES. */
export const CATEGORY_SAMPLES: readonly TicketText[] = [
  {
    title: "Reporting database query times out",
    description: "The monthly sales report query against the reporting database times out.",
  },
  {
    title: "Question about the new VPN policy",
    description: "Where can I read the new remote access policy that starts next month?",
  },
  {
    title: "Spreadsheet app crashes on start",
    description: "The spreadsheet application closes right after it starts on my laptop.",
  },
  {
    title: "Laptop screen flickers",
    description: "My laptop screen flickers and goes dark for a second every few minutes.",
  },
  {
    title: "Forgot my password",
    description: "I forgot my password and cannot sign in to my workstation this morning.",
  },
  {
    title: "Office wifi keeps dropping",
    description: "The office wifi on the third floor drops every ten minutes since Monday.",
  },
];

const HR_COMPLAINT: TicketText = {
  title: "Complaint about my manager",
  description:
    "I want to raise an HR complaint about repeated harassment by my line manager. " +
    "Please handle this confidentially.",
};

const REQUESTER = { name: "Live Test", email: "live.test@example.com", department: "IT" };
/** The synthetic persona for the sensitive HR ticket (plan §4.2). */
const ERIN = { name: "demo.erin", email: "demo.erin@example.com", department: "Operations" };

/** A ticket body; the run ID makes the text unique, so a rerun is never a duplicate. */
export function ticketBody(
  context: ScenarioContext,
  text: TicketText,
  requester: typeof REQUESTER = REQUESTER,
): Record<string, string> {
  return {
    ...requester,
    title: text.title,
    description: `${text.description} (live run ${context.runId})`,
  };
}

export const testId = (context: ScenarioContext, part: string) => `${context.runId}:${part}`;

const hasEvent = (view: InternalTicketView, type: string) =>
  view.events.some((event) => event.type === type);
const eventAt = (view: InternalTicketView, type: string): number | null => {
  const event = view.events.find((e) => e.type === type);
  return event === undefined ? null : Date.parse(event.at);
};
export const isTriaged = (view: InternalTicketView | undefined): view is InternalTicketView =>
  view !== undefined && view.status !== "failed" && hasEvent(view, "triaged");
export const fixSteps = (view: InternalTicketView): number => {
  const steps = view.triage?.suggestedFix?.["steps"];
  return Array.isArray(steps) ? steps.length : 0;
};

export interface Pending {
  readonly id: string;
  readonly deadline: number;
}

/**
 * Polls the tickets until each is triaged or failed, or past its deadline.
 * Returns the last view of every ticket.
 */
export async function waitForTriage(
  context: ScenarioContext,
  tickets: readonly Pending[],
): Promise<Map<string, InternalTicketView>> {
  const last = new Map<string, InternalTicketView>();
  let pending = [...tickets];
  while (pending.length > 0) {
    const views = await Promise.all(pending.map(({ id }) => context.client.ticket(id)));
    views.forEach((view, i) => last.set(pending[i]!.id, view));
    const at = context.now();
    pending = pending.filter(
      ({ id, deadline }) =>
        !isTriaged(last.get(id)) && last.get(id)?.status !== "failed" && at < deadline,
    );
    if (pending.length > 0) await context.sleep(POLL_MS);
  }
  return last;
}

async function createAndWait(
  context: ScenarioContext,
  body: Record<string, unknown>,
): Promise<{ id: string; view: InternalTicketView }> {
  const { ticketId } = await context.client.createTestTicket(body);
  const deadline = context.now() + TRIAGE_LIMIT_MS;
  const views = await waitForTriage(context, [{ id: ticketId, deadline }]);
  return { id: ticketId, view: views.get(ticketId)! };
}

export const result = (failedChecks: readonly string[], evidence: Evidence): ScenarioResult => ({
  status: failedChecks.length === 0 ? "pass" : "fail",
  evidence: { ...evidence, failedChecks: [...failedChecks] },
});

/**
 * T3.L.02 (DoD 4): 20 test tickets across the 6 categories all reach
 * `triaged` within 120 s each, and the p95 of redacted → triaged is under 30 s.
 */
export const triageLatencyScenario: Scenario = {
  id: "T3.L.02",
  async run(context) {
    const created: Pending[] = [];
    for (let n = 1; n <= L02_TICKETS; n++) {
      const sample = CATEGORY_SAMPLES[(n - 1) % CATEGORY_SAMPLES.length]!;
      const { ticketId } = await context.client.createTestTicket({
        ...ticketBody(context, sample),
        testId: testId(context, `L02:${n}`),
      });
      created.push({ id: ticketId, deadline: context.now() + TRIAGE_LIMIT_MS });
    }
    const views = await waitForTriage(context, created);

    const notTriaged: string[] = [];
    const missingTimes: string[] = [];
    const durations: number[] = [];
    for (const { id } of created) {
      const view = views.get(id);
      if (!isTriaged(view)) {
        notTriaged.push(id);
        continue;
      }
      const redacted = eventAt(view, "redacted");
      const triaged = eventAt(view, "triaged");
      if (redacted === null || triaged === null) missingTimes.push(id);
      else durations.push(triaged - redacted);
    }
    const p95Ms = durations.length > 0 ? p95(durations) : null;
    const failedChecks = [
      ...(notTriaged.length === 0 ? [] : ["all-triaged"]),
      ...(missingTimes.length === 0 ? [] : ["event-times"]),
      ...(p95Ms !== null && p95Ms < P95_LIMIT_MS ? [] : ["p95-under-30s"]),
    ];
    return result(failedChecks, {
      tickets: created.length,
      triaged: created.length - notTriaged.length,
      p95Ms,
      minMs: durations.length > 0 ? Math.min(...durations) : null,
      maxMs: durations.length > 0 ? Math.max(...durations) : null,
      ticketIds: created.map(({ id }) => id),
      notTriaged,
      missingTimes,
    });
  },
};

/** T3.L.03: a synthetic HR complaint from `demo.erin` goes to review, flagged `hr`. */
export const sensitiveHrScenario: Scenario = {
  id: "T3.L.03",
  async run(context) {
    const { id, view } = await createAndWait(context, {
      ...ticketBody(context, HR_COMPLAINT, ERIN),
      testId: testId(context, "L03:1"),
    });
    const triaged = isTriaged(view);
    const route = view.triage?.route ?? null;
    const sensitiveFlags = view.triage?.sensitiveFlags ?? [];
    const failedChecks = [
      ...(triaged ? [] : ["triaged"]),
      ...(route === "review" ? [] : ["route-review"]),
      ...(sensitiveFlags.includes("hr") ? [] : ["flag-hr"]),
    ];
    return result(failedChecks, { ticketId: id, status: view.status, route, sensitiveFlags });
  },
};

/** T3.F.01: with Langfuse forced down the ticket is still triaged, with `trace_export_failed`. */
export const langfuseDownScenario: Scenario = {
  id: "T3.F.01",
  async run(context) {
    const { id, view } = await createAndWait(context, {
      ...ticketBody(context, CATEGORY_SAMPLES[2]!),
      testId: testId(context, "F01:1"),
      testOverrides: { langfuseDown: true },
    });
    const triaged = isTriaged(view);
    const traceExportFailed = hasEvent(view, "trace_export_failed");
    const failedChecks = [
      ...(triaged ? [] : ["triaged"]),
      ...(traceExportFailed ? [] : ["trace-export-failed-event"]),
    ];
    return result(failedChecks, { ticketId: id, status: view.status, triaged, traceExportFailed });
  },
};

/**
 * T3.S.04 (DoD 5 and 6). (a) The form path ignores a smuggled
 * `testOverrides: { llmCallCap: 0 }`: the ticket is a test ticket (E2E mode),
 * gets fix steps and no `llm_cap_reached`. The app's form schema drops unknown
 * keys, so the request is accepted. Paced: the only form-path submit of the
 * suite. (b) The control: the same switch on the test path caps the LLM, so
 * `llm_cap_reached` and the route `review`.
 */
export const overrideIgnoredScenario: Scenario = {
  id: "T3.S.04",
  async run(context) {
    const switchOn = { llmCallCap: 0 };
    await context.pacer.acquire();
    let formTicketId: string | null = null;
    let formStatus = 201;
    try {
      const created = await context.client.submitForm({
        ...ticketBody(context, CATEGORY_SAMPLES[3]!),
        turnstileToken: TURNSTILE_TEST_TOKEN,
        testOverrides: switchOn,
      });
      formTicketId = created.ticketId;
    } catch (error) {
      if (!(error instanceof LiveContractError)) throw error;
      formStatus = error.status;
    }
    const formDeadline = context.now() + TRIAGE_LIMIT_MS;

    const control = await context.client.createTestTicket({
      ...ticketBody(context, CATEGORY_SAMPLES[3]!),
      testId: testId(context, "S04:b"),
      testOverrides: switchOn,
    });
    const pending: Pending[] = [
      ...(formTicketId === null ? [] : [{ id: formTicketId, deadline: formDeadline }]),
      { id: control.ticketId, deadline: context.now() + TRIAGE_LIMIT_MS },
    ];
    const views = await waitForTriage(context, pending);

    const form = formTicketId === null ? undefined : views.get(formTicketId);
    const formTriaged = isTriaged(form);
    const formIsTest = form?.isTest ?? null;
    const formFixSteps = form === undefined ? 0 : fixSteps(form);
    const formCapEvent = form === undefined ? null : hasEvent(form, "llm_cap_reached");
    const controlView = views.get(control.ticketId)!;
    const controlRoute = controlView.triage?.route ?? null;
    const controlCapEvent = hasEvent(controlView, "llm_cap_reached");

    const failedChecks =
      formTicketId === null
        ? ["a-form-ticket"]
        : [
            ...(formTriaged ? [] : ["a-triaged"]),
            ...(formIsTest === true ? [] : ["a-is-test"]),
            ...(formFixSteps >= 1 ? [] : ["a-fix-steps"]),
            ...(formCapEvent === false ? [] : ["a-switch-ignored"]),
          ];
    failedChecks.push(
      ...(isTriaged(controlView) ? [] : ["b-triaged"]),
      ...(controlCapEvent ? [] : ["b-cap-event"]),
      ...(controlRoute === "review" ? [] : ["b-route-review"]),
    );
    return result(failedChecks, {
      formStatus,
      formTicketId,
      formIsTest,
      formFixSteps,
      formCapEvent,
      controlTicketId: control.ticketId,
      controlRoute,
      controlCapEvent,
    });
  },
};

export const pipelineScenarios: readonly Scenario[] = [
  triageLatencyScenario,
  sensitiveHrScenario,
  langfuseDownScenario,
  overrideIgnoredScenario,
];
