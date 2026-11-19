import { HELPDESK_STATES } from "@ai-it-support/shared";
import { z } from "zod";
import type { createServerSupabaseClient } from "@/lib/supabase/server";

type StaffClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;
const state = z.enum(HELPDESK_STATES);
const action = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("note"),
    body: z
      .string()
      .min(1)
      .max(10000)
      .refine((body) => [...body].length <= 5000),
  }),
  z.strictObject({ kind: z.literal("assign"), assigneeId: z.uuid() }),
  z.strictObject({ kind: z.literal("state"), toState: state }),
]);

export function actionError(status: number, message: string) {
  return Response.json({ message }, { status, headers: { "cache-control": "no-store" } });
}

// Authorisation at the POST boundary and in each RPC. Resolve the helpdesk
// ID server-side so the submitted action cannot change a different ticket.
export async function runStaffAction(
  client: StaffClient,
  ticketId: string,
  input: unknown,
  showTestTickets: boolean,
) {
  if (!z.uuid().safeParse(ticketId).success) return actionError(404, "Ticket not found");
  const parsed = action.safeParse(input);
  if (!parsed.success) return actionError(400, "Check the action fields and try again");

  const query = client.from("tickets").select("helpdesk:helpdesk_tickets(id)").eq("id", ticketId);
  if (!showTestTickets) query.eq("is_test", false);
  const { data: ticket, error: lookupError } = await query.maybeSingle<{
    helpdesk: { id: string } | null;
  }>();
  if (lookupError?.code === "42501") return actionError(403, "You do not have access");
  if (lookupError) return actionError(500, "Could not load the ticket");
  const helpdeskId = z.uuid().safeParse(ticket?.helpdesk?.id);
  if (!helpdeskId.success) return actionError(404, "Ticket not found in the helpdesk");

  const change = parsed.data;
  const helpdesk_ticket_id = helpdeskId.data;
  const { error } = await (change.kind === "note"
    ? client.rpc("staff_add_note", { helpdesk_ticket_id, body: change.body })
    : change.kind === "assign"
      ? client.rpc("staff_assign", { helpdesk_ticket_id, assignee_id: change.assigneeId })
      : client.rpc("staff_set_state", { helpdesk_ticket_id, to_state: change.toState }));
  if (!error) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

  if (error.code === "42501") return actionError(403, "You do not have access");
  if (error.code === "P0002") return actionError(404, "Ticket not found in the helpdesk");
  if (change.kind === "assign" && error.code === "22023") {
    return actionError(409, "That assignee is no longer active");
  }
  if (change.kind === "state" && error.code === "23514") {
    // The locked RPC reports the actual state. Only echo a known enum value.
    const current = state.safeParse(
      /^illegal helpdesk transition from (\w+)$/.exec(error.message)?.[1],
    );
    const from = current.success ? current.data.replaceAll("_", " ") : "the current state";
    return actionError(409, `That change is not allowed from ${from}; the page was refreshed`);
  }
  return actionError(500, "Could not save the change");
}
