// T5.L.06 (P5-T8c): the printer fault as demo.carol, plus the run's canaries,
// as the allow-listed mailbox. The reply email must be sent once, be delivered,
// name both numbers, hold no canary, and read well (J1 on the steps, J4 on the
// text). Evidence carries IDs, numbers, statuses, times and scores only.
import {
  canaryTicketText,
  findCanaries,
  type InternalTicketView,
  type JsonState,
  type JudgeDefinition,
} from "@ai-it-support/shared";
import { LiveContractError } from "./client.ts";
import { missingResendEnv } from "./config.ts";
import {
  createHelpdeskTicket,
  INCIDENT_WAIT_MS,
  PERSONAS,
  POLL_MS,
  PRINTER_FAULT,
  serviceNowNotRun,
  serviceNowOf,
  waitForIncident,
  withCleanup,
} from "./helpdesk.ts";
import { createJudgeClient, loadJudge, type JudgeClient } from "./judge.ts";
import { canaryRunId } from "./observability.ts";
import { createE2eResend, type E2eResend, type ResendEmail } from "./resend.ts";
import { decideAndWait, SIGN, slackNotRun } from "./review-flow.ts";
import type { Evidence, Scenario, ScenarioContext, ScenarioResult } from "./runner.ts";

/** How long a sent email may take to show `delivered` (T5.L.06). */
export const DELIVERY_LIMIT_MS = 120_000;
/** How long a ticket may take to show its email row (one task start, plus lag). */
export const NOTIFICATION_LIMIT_MS = 60_000;
/** J1 (fix steps) and J4 (message clarity) must score this value or more. */
export const J1_MIN_SCORE = 0.7;
export const J4_MIN_SCORE = 0.7;
/** A report with no detail at all: the app asks for more instead of triaging. */
export const VAGUE_TICKET = {
  title: "It's broken",
  description: "it's broken, please fix",
};
/** Every test ticket's subject opens with this (resolved point 16). */
export const E2E_SUBJECT_PREFIX = "[E2E] ";
/** The fixed needs_info subject, before the ticket number (resolved points 15-16). */
export const NEEDS_INFO_SUBJECT = "More detail needed for your IT ticket ";

/** The `not_run` result when a reply-email variable is unset, else undefined. */
export function resendNotRun(context: ScenarioContext): ScenarioResult | undefined {
  const missing = missingResendEnv(context.config);
  return missing.length > 0 ? { status: "not_run", evidence: { missing } } : undefined;
}

/**
 * Polls until the ticket is `review_pending` with a card, or has reached an end
 * state of the sync (`incident_created`, skipped in shadow mode, failed).
 */
async function waitForReviewOrIncident(
  context: ScenarioContext,
  ticketId: string,
  limitMs: number,
): Promise<InternalTicketView> {
  const start = context.now();
  for (;;) {
    const view = await context.client.ticket(ticketId);
    const cardReview = view.reviews.some((r) => r.kind === "triage" && r.slackTs !== null);
    if (view.status === "review_pending" && cardReview) return view;
    if (
      view.status === "incident_created" ||
      view.status === "incident_skipped_shadow" ||
      view.status === "failed" ||
      context.now() - start >= limitMs
    ) {
      return view;
    }
    await context.sleep(POLL_MS);
  }
}

/** Polls the view until it holds a notification of `kind`, or the limit passes. */
async function waitForNotification(
  context: ScenarioContext,
  ticketId: string,
  kind: InternalTicketView["notifications"][number]["kind"],
  limitMs: number,
): Promise<{
  view: InternalTicketView;
  notification: InternalTicketView["notifications"][number] | undefined;
}> {
  const start = context.now();
  for (;;) {
    const view = await context.client.ticket(ticketId);
    const notification = view.notifications.find((row) => row.kind === kind);
    if (notification !== undefined || context.now() - start >= limitMs) {
      return { view, notification };
    }
    await context.sleep(POLL_MS);
  }
}

/** Reads the email until it is `delivered`, or the limit passes with null. */
async function waitForDelivery(
  context: ScenarioContext,
  resend: E2eResend,
  providerId: string,
): Promise<{ email: ResendEmail; deliveredMs: number | null }> {
  const start = context.now();
  for (;;) {
    const email = await resend.getEmail(providerId);
    if (email.lastEvent === "delivered") return { email, deliveredMs: context.now() - start };
    if (context.now() - start >= DELIVERY_LIMIT_MS) return { email, deliveredMs: null };
    await context.sleep(POLL_MS);
  }
}

/** The numbered steps of a reply email, in order; empty when it holds none. */
export function emailSteps(text: string): string[] {
  const steps: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\d{1,2}\. (.+)$/.exec(line.trim());
    if (match !== null) steps.push(match[1]!);
  }
  return steps;
}

export interface JudgeOutcome {
  readonly status: string;
  readonly score: number | null;
}

/** One judgment; the endpoint's refusal (422) is a status, never a throw. */
export async function judged(
  judge: JudgeClient,
  definition: JudgeDefinition,
  state: JsonState,
): Promise<JudgeOutcome> {
  try {
    const result = await judge.judge(definition, state);
    return { status: result.status, score: result.status === "completed" ? result.value : null };
  } catch (error) {
    // The judgments route refuses text redact() would change (422 unredacted_input).
    if (error instanceof LiveContractError) return { status: "refused", score: null };
    throw error;
  }
}

/**
 * T5.L.06: the printer fault with the run's canaries as demo.carol, at the
 * allow-listed mailbox. A ticket that reaches `review_pending` gets a signed
 * approve and goes on (resolved point 18). Then one `sent` `incident_reply`
 * with a provider ID; the email is `delivered` within 120 s; the ticket number
 * is in the subject and both numbers are in both bodies; no canary is in the
 * subject, text or html; J1 on the steps and J4 on the text score 0.7 or more.
 */
export const replyEmailScenario: Scenario = {
  id: "T5.L.06",
  async run(context) {
    const notRun = slackNotRun(context, SIGN) ?? serviceNowNotRun(context) ?? resendNotRun(context);
    if (notRun) return notRun;
    const sn = serviceNowOf(context);
    return withCleanup(context, sn, async (ticketIds) => {
      const checks: string[] = [];
      const evidence: Evidence = {};
      const canaryRun = canaryRunId(context.runId);
      const recipient = context.config.resend.replyRecipient!;
      const resend = createE2eResend(context.config.resend, context.fetch);
      const judge = createJudgeClient(context.client, {
        now: context.now,
        sleep: context.sleep,
      });

      const ticket = await createHelpdeskTicket(context, "L06", {
        persona: { ...PERSONAS.carol, email: recipient },
        text: {
          title: PRINTER_FAULT.title,
          description: `${PRINTER_FAULT.description}\n${canaryTicketText(canaryRun)}`,
        },
      });
      ticketIds.push(ticket.ticketId);

      let view = await waitForReviewOrIncident(context, ticket.ticketId, INCIDENT_WAIT_MS);
      const route = view.status === "review_pending" ? "review" : "auto";
      if (route === "review") {
        const review = view.reviews.find((r) => r.kind === "triage" && r.slackTs !== null);
        if (review === undefined || review.slackTs === null) {
          checks.push("review-ready");
        } else {
          const decided = await decideAndWait(
            context,
            ticket.ticketId,
            { id: review.id, slackTs: review.slackTs },
            "approve",
          );
          if (decided.status !== 200 || decided.outcome !== "recorded") {
            checks.push("approve-recorded");
          }
        }
        view = await waitForIncident(context, ticket.ticketId, INCIDENT_WAIT_MS);
      }

      const notified = await waitForNotification(
        context,
        ticket.ticketId,
        "incident_reply",
        NOTIFICATION_LIMIT_MS,
      );
      view = notified.view;
      const notification = notified.notification;

      let email: ResendEmail | undefined;
      let deliveredMs: number | null = null;
      const providerId = notification?.providerId ?? null;
      if (providerId !== null) {
        const read = await waitForDelivery(context, resend, providerId);
        email = read.email;
        deliveredMs = read.deliveredMs;
      }

      const ticketNumber = view.number;
      const incidentNumber = view.incident?.number ?? null;
      const subjectNumber = email !== undefined && email.subject.includes(ticketNumber);
      const holdsBoth = (body: string): boolean =>
        body.includes(ticketNumber) && incidentNumber !== null && body.includes(incidentNumber);
      const textNumbers = email !== undefined && email.text !== null && holdsBoth(email.text);
      const htmlNumbers = email !== undefined && holdsBoth(email.html);
      const scanned = email === undefined ? [] : [email.subject, email.text ?? "", email.html];
      const canaryHits = scanned.reduce(
        (sum, body) => sum + findCanaries(body, canaryRun).reduce((n, hit) => n + hit.count, 0),
        0,
      );

      if (view.status !== "incident_created") checks.push("status-incident-created");
      if (
        notification === undefined ||
        notification.status !== "sent" ||
        notification.kind !== "incident_reply" ||
        notification.providerId === null
      ) {
        checks.push("notification-sent");
      }
      if (deliveredMs === null) checks.push("email-delivered-within-120s");
      if (!subjectNumber) checks.push("subject-ticket-number");
      if (!textNumbers) checks.push("text-holds-numbers");
      if (!htmlNumbers) checks.push("html-holds-numbers");
      if (canaryHits > 0) checks.push("no-canaries");

      // With a canary in the email, no judge call is made: the text must not
      // leave, and the two score checks then fail.
      const steps = email?.text == null ? [] : emailSteps(email.text);
      let j1Score: number | null = null;
      let j4Score: number | null = null;
      if (canaryHits === 0) {
        if (view.redacted === null) {
          checks.push("redacted-view");
        } else if (steps.length > 0) {
          const outcome = await judged(judge, loadJudge("J1"), {
            ticket: { title: view.redacted.title, description: view.redacted.description },
            fixSteps: steps,
          });
          j1Score = outcome.score;
        }
        if (email?.text != null) {
          const outcome = await judged(judge, loadJudge("J4"), {
            message: email.text,
            reader: "the person who raised an IT ticket",
          });
          j4Score = outcome.score;
        }
      }
      if (j1Score === null || j1Score < J1_MIN_SCORE) checks.push("j1-score");
      if (j4Score === null || j4Score < J4_MIN_SCORE) checks.push("j4-score");

      Object.assign(evidence, {
        ticketId: ticket.ticketId,
        ticketNumber,
        incidentNumber,
        status: view.status,
        route,
        notificationKind: notification?.kind ?? null,
        notificationStatus: notification?.status ?? null,
        deliveredMs,
        subjectNumber,
        textNumbers,
        htmlNumbers,
        canaryHits,
        j1Score,
        j4Score,
        aiCallCount: view.aiCallCount,
      });
      return { checks, evidence };
    });
  },
};

/**
 * T5.L.07: a vague report ("it's broken, please fix") from demo.carol at the
 * allow-listed mailbox. The triage flags hold `needs_info`, the status is
 * `review_pending`, one `sent` `needs_info` email whose subject is the details
 * variant; then a signed reject, so the ticket does not wait on a review. The
 * reject is signed even when a check above failed.
 */
export const needsInfoScenario: Scenario = {
  id: "T5.L.07",
  async run(context) {
    const notRun = slackNotRun(context, SIGN) ?? serviceNowNotRun(context) ?? resendNotRun(context);
    if (notRun) return notRun;
    const sn = serviceNowOf(context);
    return withCleanup(context, sn, async (ticketIds) => {
      const checks: string[] = [];
      const evidence: Evidence = {};
      const recipient = context.config.resend.replyRecipient!;
      const resend = createE2eResend(context.config.resend, context.fetch);

      const ticket = await createHelpdeskTicket(context, "L07", {
        persona: { ...PERSONAS.carol, email: recipient },
        text: VAGUE_TICKET,
      });
      ticketIds.push(ticket.ticketId);

      let view = await waitForReviewOrIncident(context, ticket.ticketId, INCIDENT_WAIT_MS);
      const reviewStatus = view.status;
      const flags = view.triage?.flags ?? [];
      let notification: InternalTicketView["notifications"][number] | undefined;
      let email: ResendEmail | undefined;
      let decision: Awaited<ReturnType<typeof decideAndWait>> | undefined;
      try {
        const notified = await waitForNotification(
          context,
          ticket.ticketId,
          "needs_info",
          NOTIFICATION_LIMIT_MS,
        );
        view = notified.view;
        notification = notified.notification;
        if (notification?.providerId != null) {
          email = await resend.getEmail(notification.providerId);
        }
      } finally {
        // The ticket must not wait on a review, whatever the checks found.
        const review = view.reviews.find((r) => r.kind === "triage" && r.slackTs !== null);
        if (review !== undefined && review.slackTs !== null) {
          decision = await decideAndWait(
            context,
            ticket.ticketId,
            { id: review.id, slackTs: review.slackTs },
            "reject",
          );
        }
      }

      const subjectVariant =
        email !== undefined &&
        email.subject === `${E2E_SUBJECT_PREFIX}${NEEDS_INFO_SUBJECT}${view.number}`;
      if (reviewStatus !== "review_pending") checks.push("review-pending");
      if (!flags.includes("needs_info")) checks.push("triage-flags-needs-info");
      if (
        notification === undefined ||
        notification.kind !== "needs_info" ||
        notification.status !== "sent" ||
        notification.providerId === null
      ) {
        checks.push("needs-info-notification");
      }
      if (!subjectVariant) checks.push("needs-info-subject");
      if (decision === undefined || decision.view.status !== "rejected") checks.push("rejected");

      Object.assign(evidence, {
        ticketId: ticket.ticketId,
        ticketNumber: view.number,
        status: decision?.view.status ?? view.status,
        route: view.triage?.route ?? null,
        triageFlags: [...flags],
        notificationKind: notification?.kind ?? null,
        notificationStatus: notification?.status ?? null,
        subjectVariant,
        decisionOutcome: decision?.outcome ?? null,
        aiCallCount: view.aiCallCount,
      });
      return { checks, evidence };
    });
  },
};

export const replyScenarios: readonly Scenario[] = [replyEmailScenario, needsInfoScenario];
