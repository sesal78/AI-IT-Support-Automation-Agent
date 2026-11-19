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
  const review = { id: reviewId, decision: null, wait_token_id: token };
  return {
    e2eMode: false,
    repos: {
      getTicket: vi.fn().mockResolvedValue({ status: "review_pending", is_test: false }),
      getTriageReview: vi.fn().mockResolvedValue(review),
      decideReview: vi.fn().mockResolvedValue({
        changed: true,
        review: { ...review, decision: "approve", staff_id: admin.id },
      }),
    },
    completeToken: vi.fn().mockResolvedValue(undefined),
  };
}

it("records the decision as the authenticated admin and sends no token to the client", async () => {
  const deps = harness();
  const response = await decideStaffReview(deps, admin, ticketId, click());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "recorded" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(deps.repos.getTicket).toHaveBeenCalledExactlyOnceWith(ticketId);
  expect(deps.repos.getTriageReview).toHaveBeenCalledExactlyOnceWith(ticketId);
  expect(deps.repos.decideReview).toHaveBeenCalledExactlyOnceWith(reviewId, "approve", {
    source: "helpdesk",
    staffId: admin.id,
  });
  expect(deps.completeToken).toHaveBeenCalledExactlyOnceWith(token, {
    reviewId,
    decision: "approve",
  });
});

it.each([
  [{ ...admin, role: "agent" } as const, ticketId, click(), 403],
  [{ ...admin, active: false }, ticketId, click(), 403],
  [admin, "ITS-000001", click(), 404],
  [admin, ticketId, { decision: "timeout" }, 400],
  [admin, ticketId, { ...click(), staffId: admin.id }, 400],
])(
  "rejects invalid authority or input before privileged reads",
  async (staff, id, input, status) => {
    const deps = harness();
    expect((await decideStaffReview(deps, staff, id, input)).status).toBe(status);
    expect(deps.repos.getTicket).not.toHaveBeenCalled();
    expect(deps.completeToken).not.toHaveBeenCalled();
  },
);

it.each([null, { status: "review_pending", is_test: true }])(
  "hides an absent or test ticket",
  async (ticket) => {
    const deps = harness();
    deps.repos.getTicket.mockResolvedValue(ticket);
    expect((await decideStaffReview(deps, admin, ticketId, click())).status).toBe(404);
    expect(deps.repos.getTriageReview).not.toHaveBeenCalled();
  },
);

it("permits test tickets only in E2E mode", async () => {
  const deps = { ...harness(), e2eMode: true };
  deps.repos.getTicket.mockResolvedValue({ status: "review_pending", is_test: true });
  expect((await decideStaffReview(deps, admin, ticketId, click())).status).toBe(200);
});

it("rejects a missing or not yet waiting review without writes", async () => {
  const deps = harness();
  deps.repos.getTriageReview.mockResolvedValueOnce(null);
  expect((await decideStaffReview(deps, admin, ticketId, click())).status).toBe(404);
  deps.repos.getTicket.mockResolvedValueOnce({ status: "triaged", is_test: false });
  expect((await decideStaffReview(deps, admin, ticketId, click())).status).toBe(409);
  expect(deps.repos.decideReview).not.toHaveBeenCalled();
});

it.each([
  ["timeout", "late"],
  ["reject", "already_decided"],
])("returns the stored terminal %s decision without writes", async (decision, outcome) => {
  const deps = harness();
  deps.repos.getTicket.mockResolvedValue({ status: "escalated_manual", is_test: false });
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
