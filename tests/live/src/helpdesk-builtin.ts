import { canaryTicketText, findCanaries, type InternalTicketView } from "@ai-it-support/shared";
import {
  createHelpdeskTicket,
  INCIDENT_DEADLINE_MS,
  INCIDENT_WAIT_MS,
  incidentCreatedAt,
  PERSONAS,
  PRINTER_FAULT,
  waitForIncident,
  waitForReviewOrIncident,
} from "./helpdesk.ts";
import { canaryRequester, canaryTicketTitle } from "./helpdesk-leak.ts";
import { HR_COMPLAINT, QUIET_MS } from "./helpdesk-scenarios.ts";
import { canaryRunId } from "./observability.ts";
import { result } from "./pipeline.ts";
import { decideAndWait, READ_SLACK, SIGN, slackNotRun, slackOf } from "./review-flow.ts";
import type { Scenario, ScenarioContext } from "./runner.ts";

function builtinReady(id: string, run: Scenario["run"]): Scenario {
  return {
    id,
    // Do not mix these with the ServiceNow run. Select them explicitly after H31.
    heavy: true,
    async run(context) {
      const config = await context.client.healthConfig();
      if (config.helpdesk !== "builtin" || !config.features.builtinHelpdesk) {
        return { status: "not_run", evidence: { missing: "builtin-helpdesk" } };
      }
      return run(context);
    },
  };
}

const createPrinter = (context: ScenarioContext, scenario: string) =>
  createHelpdeskTicket(context, scenario, { persona: PERSONAS.carol, text: PRINTER_FAULT, n: 1 });

function newBuiltin(view: InternalTicketView): boolean {
  return (
    view.status === "incident_created" &&
    view.helpdesk?.kind === "builtin" &&
    view.helpdesk.state === "new" &&
    view.incident === null
  );
}

function triageCard(view: InternalTicketView) {
  const review = view.reviews.find((entry) => entry.kind === "triage");
  return review?.slackTs ? { id: review.id, slackTs: review.slackTs } : undefined;
}

const auto = builtinReady("T5.L.09", async (context) => {
  const { ticketId } = await createPrinter(context, "L09");
  const view = await waitForIncident(context, ticketId, INCIDENT_WAIT_MS);
  const created = incidentCreatedAt(view);
  const elapsedMs = created === null ? null : created - Date.parse(view.createdAt);
  const checks: string[] = [];
  if (view.triage?.route !== "auto") checks.push("route-auto");
  if (!newBuiltin(view)) checks.push("new-builtin-ticket");
  if (elapsedMs === null || elapsedMs < 0 || elapsedMs >= INCIDENT_DEADLINE_MS)
    checks.push("builtin-within-60s");
  return result(checks, { ticketId, helpdeskNumber: view.helpdesk?.number ?? null, elapsedMs });
});

const duplicate = builtinReady("T5.L.10", async (context) => {
  const first = await createPrinter(context, "L10");
  const original = await waitForIncident(context, first.ticketId, INCIDENT_WAIT_MS);
  const repeated = await createPrinter(context, "L10");
  const view = await waitForIncident(context, repeated.ticketId, INCIDENT_WAIT_MS);
  const createdEvents = view.events.filter((event) => event.type === "incident_created").length;
  const checks: string[] = [];
  if (first.ticketId !== repeated.ticketId) checks.push("same-ticket-id");
  if (
    !newBuiltin(original) ||
    !newBuiltin(view) ||
    original.helpdesk?.number !== view.helpdesk?.number
  )
    checks.push("same-builtin-ticket");
  if (createdEvents !== 1) checks.push("one-incident-created-event");
  return result(checks, {
    ticketId: view.id,
    helpdeskNumber: view.helpdesk?.number ?? null,
    createdEvents,
  });
});

const reject = builtinReady("T5.L.11", async (context) => {
  const notRun = slackNotRun(context, SIGN);
  if (notRun) return notRun;
  const { ticketId } = await createHelpdeskTicket(context, "L11", {
    persona: PERSONAS.erin,
    text: HR_COMPLAINT,
  });
  const initial = await waitForReviewOrIncident(context, ticketId, INCIDENT_WAIT_MS);
  const card = triageCard(initial);
  if (initial.status !== "review_pending" || initial.triage?.sensitive !== true || !card)
    return result(["sensitive-review-ready"], { ticketId });
  const decision = await decideAndWait(context, ticketId, card, "reject");
  await context.sleep(QUIET_MS);
  const view = await context.client.ticket(ticketId);
  const checks: string[] = [];
  if (decision.status !== 200 || decision.outcome !== "recorded" || view.status !== "rejected")
    checks.push("reject-recorded");
  if (view.helpdesk !== null || view.incident !== null || incidentCreatedAt(view) !== null)
    checks.push("rejected-no-helpdesk");
  return result(checks, { ticketId, status: view.status });
});

const canary = builtinReady("T5.S.06", async (context) => {
  const notRun = slackNotRun(context, [...READ_SLACK, ...SIGN]);
  if (notRun) return notRun;
  const slack = slackOf(context);
  const { channelId } = await slack.verify();
  const since = context.now();
  const runId = canaryRunId(context.runId);
  const { ticketId } = await createHelpdeskTicket(context, "S06", {
    persona: { ...PERSONAS.carol, email: canaryRequester(runId) },
    text: { title: canaryTicketTitle, description: canaryTicketText(runId) },
  });
  let view = await waitForReviewOrIncident(context, ticketId, INCIDENT_WAIT_MS);
  const checks: string[] = [];
  const card = triageCard(view);
  if (view.status === "review_pending") {
    if (!card) return result(["review-ready"], { ticketId });
    const decided = await decideAndWait(context, ticketId, card, "approve");
    if (decided.status !== 200 || decided.outcome !== "recorded") checks.push("approve-recorded");
    view = await waitForIncident(context, ticketId, INCIDENT_WAIT_MS);
  }

  const history = await slack.history(channelId, { oldest: String(Math.floor(since / 1000)) });
  const thread = card ? await slack.replies(channelId, card.slackTs) : [];
  if (card && !thread.some((message) => message.ts === card.slackTs))
    checks.push("slack-review-thread");
  const messages = [...history, ...thread];
  if (!newBuiltin(view)) checks.push("new-builtin-ticket");
  if (findCanaries(JSON.stringify(view.helpdesk), runId).length > 0)
    checks.push("canary-in-builtin-view");
  if (messages.some((message) => findCanaries(JSON.stringify(message), runId).length > 0))
    checks.push("canary-in-slack");
  // The operator scans the exported logs after the run, as for T3.L.04.
  return result(checks, {
    ticketId,
    helpdeskNumber: view.helpdesk?.number ?? null,
    canaryRunId: runId,
    slackMessagesScanned: messages.length,
    logsSince: new Date(since).toISOString(),
    logExports: [
      "dokploy:e2e-web",
      "trigger.dev:e2e-intake-ticket",
      "trigger.dev:e2e-triage-ticket",
      "trigger.dev:e2e-review-ticket",
      "trigger.dev:e2e-helpdesk-sync",
      "trigger.dev:e2e-notify-requester",
    ],
  });
});

export const builtinScenarios: readonly Scenario[] = [auto, duplicate, reject, canary];
