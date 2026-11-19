import { expect, it, vi } from "vitest";
import type { Review } from "@ai-it-support/db";
import { decideAndResume } from "./review-resume";

const reviewId = "11111111-1111-4111-8111-000000000011";
const staffId = "11111111-1111-4111-8111-000000000022";
const staff = { source: "helpdesk", staffId } as const;
const slack = "U0A5ATR4WJD";

function harness(stored: Partial<Review>, changed = false) {
  return {
    repos: {
      decideReview: vi.fn().mockResolvedValue({
        changed,
        review: { id: reviewId, decision: "approve", wait_token_id: "fixture-wait-id", ...stored },
      }),
    },
    completeToken: vi.fn().mockResolvedValue(undefined),
  };
}

it.each([
  [staff, { slack_user_id: slack }],
  [slack, { staff_id: staffId }],
] as const)("does not resume a matching decision from the other channel", async (actor, stored) => {
  const deps = harness(stored);
  expect(await decideAndResume(deps, reviewId, "approve", actor)).toBe("already_decided");
  expect(deps.completeToken).not.toHaveBeenCalled();
});

it("allows the winning staff decision and a matching retry from the same admin", async () => {
  for (const changed of [true, false]) {
    const deps = harness({ staff_id: staffId }, changed);
    expect(await decideAndResume(deps, reviewId, "approve", staff)).toBe(
      changed ? "recorded" : "already_decided",
    );
    expect(deps.repos.decideReview).toHaveBeenCalledWith(reviewId, "approve", staff);
    expect(deps.completeToken).toHaveBeenCalledExactlyOnceWith("fixture-wait-id", {
      reviewId,
      decision: "approve",
    });
  }
});

it("reports a timeout without completing its token", async () => {
  const deps = harness({ decision: "timeout" });
  expect(await decideAndResume(deps, reviewId, "approve", staff)).toBe("late");
  expect(deps.completeToken).not.toHaveBeenCalled();
});
