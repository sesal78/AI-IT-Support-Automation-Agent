import { expect, it, vi } from "vitest";
import type { StaffMember } from "./auth";
import { decideStaffReview } from "./decide";

const ticketId = "11111111-1111-4111-8111-000000000011";
const reviewId = "11111111-1111-4111-8111-000000000012";
const admin = {
  id: "11111111-1111-4111-8111-000000000013",
  role: "admin",
  displayName: "Test admin",
  active: true,
} satisfies StaffMember;
const token = "fixture-private-wait";
const click = (decision: "approve" | "reject" = "approve") => ({ decision });

function harness() {
  const review = {
    id: reviewId,
    decision: null,
    wait_token_id: token,
    slack_ts: "1800000000.000100",
  };
  return {
    e2eMode: false,
    readTicket: vi.fn().mockResolvedValue({ status: "review_pending", is_test: false }),
    repos: {
      getTriageReview: vi.fn().mockResolvedValue(review),
      decideReview: vi.fn().mockResolvedValue({
        changed: true,
        review: { ...review, decision: "approve", staff_id: admin.id },
      }),
    },
    readWaitpoint: vi.fn().mockResolvedValue({ status: "WAITING" }),
    completeToken: vi.fn().mockResolvedValue(undefined),
  };
}

it.each(["approve", "reject"] as const)(
  "records %s as the authenticated admin and hides the token",
  async (decision) => {
    const deps = harness();
    const response = await decideStaffReview(deps, admin, ticketId, click(decision));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "recorded" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(deps.readTicket).toHaveBeenCalledExactlyOnceWith(ticketId);
    expect(deps.repos.getTriageReview).toHaveBeenCalledExactlyOnceWith(ticketId);
    expect(deps.repos.decideReview).toHaveBeenCalledExactlyOnceWith(reviewId, decision, {
      source: "helpdesk",
      staffId: admin.id,
    });
    expect(deps.completeToken).toHaveBeenCalledExactlyOnceWith(token, {
      reviewId,
      decision,
    });
  },
);

it.each([
  [{ ...admin, role: "agent" } as const, ticketId, click(), 403, "forbidden"],
  [{ ...admin, active: false }, ticketId, click(), 403, "forbidden"],
  [admin, "ITS-000001", click(), 404, "not_found"],
  [admin, ticketId, { decision: "timeout" }, 400, "bad_request"],
  [admin, ticketId, { ...click(), staffId: admin.id }, 400, "bad_request"],
])(
  "rejects invalid authority or input before any reads",
  async (staff, id, input, status, error) => {
    const deps = harness();
    const response = await decideStaffReview(deps, staff, id, input);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(deps.readTicket).not.toHaveBeenCalled();
    expect(deps.completeToken).not.toHaveBeenCalled();
  },
);

it.each([null, { status: "review_pending", is_test: true }])(
  "hides an absent or test ticket",
  async (ticket) => {
    const deps = harness();
    deps.readTicket.mockResolvedValue(ticket);
    const response = await decideStaffReview(deps, admin, ticketId, click());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(deps.repos.getTriageReview).not.toHaveBeenCalled();
  },
);

it("permits test tickets only in E2E mode", async () => {
  const deps = { ...harness(), e2eMode: true };
  deps.readTicket.mockResolvedValue({ status: "review_pending", is_test: true });
  expect((await decideStaffReview(deps, admin, ticketId, click())).status).toBe(200);
});

it("rejects a missing or not yet waiting review without writes", async () => {
  const deps = harness();
  deps.repos.getTriageReview.mockResolvedValueOnce(null);
  const absent = await decideStaffReview(deps, admin, ticketId, click());
  expect(absent.status).toBe(404);
  expect(await absent.json()).toEqual({ error: "not_found" });
  deps.readTicket.mockResolvedValueOnce({ status: "triaged", is_test: false });
  const pending = await decideStaffReview(deps, admin, ticketId, click());
  expect(pending.status).toBe(409);
  expect(await pending.json()).toEqual({ error: "not_waiting_for_review" });
  expect(deps.repos.decideReview).not.toHaveBeenCalled();
});

it.each([
  ["timeout", "late"],
  ["reject", "already_decided"],
])("returns the stored terminal %s decision without writes", async (decision, outcome) => {
  const deps = harness();
  deps.readTicket.mockResolvedValue({ status: "escalated_manual", is_test: false });
  deps.repos.getTriageReview.mockResolvedValue({ id: reviewId, decision });
  const response = await decideStaffReview(deps, admin, ticketId, click());
  expect(await response.json()).toEqual({ outcome });
  expect(deps.repos.decideReview).not.toHaveBeenCalled();
  expect(deps.completeToken).not.toHaveBeenCalled();
});

it("keeps wait-token details out of a provider error response", async () => {
  const deps = harness();
  deps.completeToken.mockRejectedValue(new Error(token));
  const response = await decideStaffReview(deps, admin, ticketId, click());
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "internal_error" });
});

it("refuses a review until the pipeline has posted its card", async () => {
  const deps = harness();
  deps.repos.getTriageReview.mockResolvedValue({ id: reviewId, decision: null, slack_ts: null });
  const pending = await decideStaffReview(deps, admin, ticketId, click());
  expect(pending.status).toBe(409);
  expect(await pending.json()).toEqual({ error: "not_waiting_for_review" });
  expect(deps.repos.decideReview).not.toHaveBeenCalled();
  expect(deps.completeToken).not.toHaveBeenCalled();
});

it.each([
  [{ status: "TIMED_OUT" }, "late"],
  [{ status: "WAITING", timeoutAt: new Date(0) }, "late"],
  [{ status: "COMPLETED" }, "already_decided"],
])(
  "refuses a settled or expired waitpoint before the database decision",
  async (state, outcome) => {
    const deps = harness();
    deps.readWaitpoint.mockResolvedValue(state);
    const response = await decideStaffReview(deps, admin, ticketId, click());
    expect(await response.json()).toEqual({ outcome });
    expect(deps.readWaitpoint).toHaveBeenCalledExactlyOnceWith(token);
    expect(deps.repos.decideReview).not.toHaveBeenCalled();
    expect(deps.completeToken).not.toHaveBeenCalled();
  },
);

it("writes nothing when the waitpoint status is unavailable", async () => {
  const deps = harness();
  deps.readWaitpoint.mockRejectedValue(new Error(token));
  const response = await decideStaffReview(deps, admin, ticketId, click());
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "internal_error" });
  expect(deps.repos.decideReview).not.toHaveBeenCalled();
});

it("can retry the recorded staff decision without extending the deadline", async () => {
  const deps = harness();
  const stored = {
    id: reviewId,
    decision: "approve",
    staff_id: admin.id,
    wait_token_id: token,
    slack_ts: "1800000000.000100",
  };
  deps.repos.getTriageReview.mockResolvedValue(stored);
  deps.repos.decideReview.mockResolvedValue({ changed: false, review: stored });
  const response = await decideStaffReview(deps, admin, ticketId, click());
  expect(await response.json()).toEqual({ outcome: "already_decided" });
  expect(deps.readWaitpoint).not.toHaveBeenCalled();
  expect(deps.completeToken).toHaveBeenCalledTimes(1);
});
