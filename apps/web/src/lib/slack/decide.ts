import type { Repositories, Review } from "@ai-it-support/db";
import {
  errorName,
  json,
  log,
  recordRefusal,
  type InteractivityDeps,
  type RequestSample,
} from "@/lib/slack/handler";
import { checkReviewBinding, type Interaction } from "@/lib/slack/interaction";

// Records an allowed Approve / Reject click and completes the review's wait
// token (P4-T3d). The token ID is read from the stored row only: it never
// comes from the payload and never reaches a response or a log line.

export type Outcome = "recorded" | "already_decided" | "late";

export interface DecideDeps {
  repos: Pick<Repositories, "getReview" | "getTicket" | "decideReview">;
  recordSecurityEvent: InteractivityDeps["recordSecurityEvent"];
  channelId: string;
  e2eMode: boolean;
  /** `wait.completeToken` from @trigger.dev/sdk; completing a completed token is a no-op. */
  completeToken: (
    tokenId: string,
    output: { reviewId: string; decision: Interaction["decision"] },
  ) => Promise<unknown>;
  fetch: typeof fetch;
}

const NOTICES = {
  already_decided: "This ticket was already decided.",
  late: "This review timed out; the ticket is in the manual queue.",
} as const;

export function createDecide(deps: DecideDeps) {
  /** Best effort: a failed post is logged by class name and never changes the answer. */
  async function notify(responseUrl: string, outcome: keyof typeof NOTICES, ids: object) {
    try {
      const res = await deps.fetch(responseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response_type: "ephemeral",
          replace_original: false,
          text: NOTICES[outcome],
        }),
        // A 3xx from the hook is an error, never followed.
        redirect: "error",
      });
      if (!res.ok) log("error", "notice failed", { ...ids, status: res.status });
    } catch (error) {
      log("error", "notice failed", { ...ids, error: errorName(error) });
    }
  }

  return async (interaction: Interaction, sample: RequestSample): Promise<Response> => {
    const { reviewId, decision } = interaction;
    let ids: { reviewId: string; ticketId?: string } = { reviewId };
    let stored: Review;
    let changed: boolean;
    try {
      const review = await deps.repos.getReview(reviewId);
      const ticket = review ? await deps.repos.getTicket(review.ticket_id) : null;
      const check = checkReviewBinding({
        interaction,
        channelId: deps.channelId,
        e2eMode: deps.e2eMode,
        review: review && { ticketId: review.ticket_id, slackTs: review.slack_ts },
        ticket: ticket && { isTest: ticket.is_test },
      });
      if (!check.allowed) {
        await recordRefusal(deps.recordSecurityEvent, check.kind, sample);
        return json({ error: check.status === 404 ? "not_found" : "forbidden" }, check.status);
      }
      ids = { reviewId, ticketId: review!.ticket_id };
      ({ changed, review: stored } = await deps.repos.decideReview(
        reviewId,
        decision,
        interaction.userId,
      ));
    } catch (error) {
      log("error", "decision failed", { ...ids, error: errorName(error) });
      return json({ error: "internal_error" }, 500);
    }

    // Another decision is stored: answer, never complete the token.
    if (!changed && stored.decision !== decision) {
      const outcome = stored.decision === "timeout" ? "late" : "already_decided";
      await notify(interaction.responseUrl, outcome, ids);
      log("info", "decision", { ...ids, outcome });
      return json({ outcome }, 200);
    }

    // This decision is stored (now or before): complete the token, again if need be.
    try {
      await deps.completeToken(stored.wait_token_id, { reviewId, decision });
    } catch (error) {
      log("error", "token completion failed", { ...ids, error: errorName(error) });
      return json({ error: "internal_error" }, 500);
    }
    const outcome: Outcome = changed ? "recorded" : "already_decided";
    if (!changed) await notify(interaction.responseUrl, "already_decided", ids);
    log("info", "decision", { ...ids, outcome });
    return json({ outcome }, 200);
  };
}
