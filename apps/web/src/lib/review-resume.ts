import type { Repositories, ReviewActor } from "@ai-it-support/db";

export type Outcome = "recorded" | "already_decided" | "late";

interface ResumeDeps {
  repos: Pick<Repositories, "decideReview">;
  completeToken: (
    tokenId: string,
    output: { reviewId: string; decision: "approve" | "reject" },
  ) => Promise<unknown>;
}

export class ReviewResumeError extends Error {
  constructor(cause: unknown) {
    super("Could not resume the review", { cause });
    this.name = "ReviewResumeError";
  }
}

/** Store the first decision and complete its server-side wait token. */
export async function decideAndResume(
  deps: ResumeDeps,
  reviewId: string,
  decision: "approve" | "reject",
  actor: ReviewActor | string,
): Promise<Outcome> {
  const { changed, review } = await deps.repos.decideReview(reviewId, decision, actor);
  if (review.decision === "timeout") return "late";

  // Preserve Slack's existing retry recovery. A loser from the other channel
  // must not complete the winner's token, even if it chose the same decision.
  const retryingWinner =
    typeof actor !== "string" && actor.source === "helpdesk"
      ? review.staff_id === actor.staffId
      : !review.staff_id;
  if (!changed && (review.decision !== decision || !retryingWinner)) return "already_decided";

  try {
    await deps.completeToken(review.wait_token_id, { reviewId, decision });
  } catch (error) {
    throw new ReviewResumeError(error);
  }
  return changed ? "recorded" : "already_decided";
}
