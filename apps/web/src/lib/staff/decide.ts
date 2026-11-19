import type { Repositories } from "@ai-it-support/db";
import { z } from "zod";
import { decideAndResume, type Outcome } from "@/lib/review-resume";
import type { StaffMember } from "./auth";

interface StaffDecisionDeps {
  repos: Pick<Repositories, "getTicket" | "getTriageReview" | "decideReview">;
  completeToken: Parameters<typeof decideAndResume>[0]["completeToken"];
  e2eMode: boolean;
}

const payload = z.strictObject({ decision: z.enum(["approve", "reject"]) });

function respond(value: { outcome: Outcome } | { error: string }, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

/** The caller supplies the staff member returned by the admin session guard. */
export async function decideStaffReview(
  deps: StaffDecisionDeps,
  staff: StaffMember,
  ticketId: string,
  input: unknown,
) {
  if (staff.role !== "admin" || !staff.active) return respond({ error: "forbidden" }, 403);
  if (!z.uuid().safeParse(ticketId).success) return respond({ error: "not_found" }, 404);
  const parsed = payload.safeParse(input);
  if (!parsed.success) return respond({ error: "bad_request" }, 400);

  try {
    const ticket = await deps.repos.getTicket(ticketId);
    if (!ticket || (ticket.is_test && !deps.e2eMode)) return respond({ error: "not_found" }, 404);
    const review = await deps.repos.getTriageReview(ticketId);
    if (!review) return respond({ error: "not_found" }, 404);
    if (ticket.status !== "review_pending") {
      if (review.decision === "timeout") return respond({ outcome: "late" });
      if (review.decision !== null) return respond({ outcome: "already_decided" });
      return respond({ error: "not_waiting_for_review" }, 409);
    }
    const outcome = await decideAndResume(deps, review.id, parsed.data.decision, {
      source: "helpdesk",
      staffId: staff.id,
    });
    return respond({ outcome });
  } catch (error) {
    console.error(
      "staff review decision failed",
      error instanceof Error ? error.constructor.name : "UnknownError",
    );
    return respond({ error: "internal_error" }, 500);
  }
}
