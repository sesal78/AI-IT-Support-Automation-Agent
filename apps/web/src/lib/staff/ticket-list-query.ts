import {
  CATEGORIES,
  HELPDESK_STATES,
  PRIORITIES,
  TICKET_STATUSES,
  ticketNumberSchema,
  type Category,
  type HelpdeskState,
  type Priority,
  type TicketStatus,
} from "@ai-it-support/shared";
import { z } from "zod";
import type { createServerSupabaseClient } from "@/lib/supabase/server";
import { TICKET_LIST_PAGE_SIZE, type TicketListFilters } from "./ticket-list-filters";

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export interface StaffTicketRow {
  id: string;
  ticketNumber: string;
  helpdeskNumber: string | null;
  pipelineStatus: TicketStatus;
  helpdeskState: HelpdeskState | null;
  priority: Priority | null;
  category: Category | null;
  assigneeName: string | null;
  redactedTitle: string | null;
  createdAt: string;
}

export interface StaffTicketListPage {
  rows: StaffTicketRow[];
  total: number;
  page: number;
  pageCount: number;
}

// Use the foreign keys from migrations 0002 and 0007. Every selected field
// is covered by migration 0008's staff grants.
const columns = [
  "id,ticket_number,status,created_at",
  "redaction:ticket_redactions(redacted_title)",
  "triage:triage_results(priority,category)",
  "helpdesk:helpdesk_tickets(number,state,priority,category,assignee:staff!helpdesk_tickets_assignee_id_fkey(display_name))",
].join(",");

const rowSchema = z.strictObject({
  id: z.uuid(),
  ticket_number: ticketNumberSchema,
  status: z.enum(TICKET_STATUSES),
  created_at: z.iso.datetime({ offset: true }),
  redaction: z.strictObject({ redacted_title: z.string() }).nullable(),
  triage: z
    .strictObject({
      priority: z.enum(PRIORITIES).nullable(),
      category: z.enum(CATEGORIES).nullable(),
    })
    .nullable(),
  helpdesk: z
    .strictObject({
      number: z.string().regex(/^HD[0-9]{7}$/),
      state: z.enum(HELPDESK_STATES),
      priority: z.enum(PRIORITIES),
      category: z.enum(CATEGORIES),
      assignee: z.strictObject({ display_name: z.string() }).nullable(),
    })
    .nullable(),
});

function ticketListQuery(supabase: ServerSupabaseClient, filters: TicketListFilters) {
  const { status, priority, category, showTestTickets } = filters;
  const helpdeskState =
    status && status !== "manual" && status !== "review_pending" ? status : null;
  const filterTriage = !helpdeskState && (priority !== null || category !== null);
  // Keep an unfiltered helpdesk embed for presence: a nonmatching helpdesk
  // row must never fall back to its ticket's older triage values.
  const query = supabase
    .from("tickets")
    .select(filterTriage ? columns + ",has_helpdesk:helpdesk_tickets()" : columns, {
      count: "exact",
    });
  if (!showTestTickets) query.eq("is_test", false);
  if (status === "manual") query.in("status", ["rejected", "escalated_manual"]);
  if (status === "review_pending") query.eq("status", status);
  if (helpdeskState) query.eq("helpdesk.state", helpdeskState).not("helpdesk", "is", null);
  if (priority) query.eq("helpdesk.priority", priority);
  if (category) query.eq("helpdesk.category", category);
  if (filterTriage) {
    if (priority) query.eq("triage.priority", priority);
    if (category) query.eq("triage.category", category);
    query.or("helpdesk.not.is.null,and(has_helpdesk.is.null,triage.not.is.null)");
  }
  return query.order("created_at", { ascending: false }).order("id", { ascending: true });
}

export async function listStaffTickets(
  supabase: ServerSupabaseClient,
  filters: TicketListFilters,
): Promise<StaffTicketListPage> {
  const page = filters.page;
  const start = (page - 1) * TICKET_LIST_PAGE_SIZE;
  const query = ticketListQuery(supabase, filters);
  const result = await query.range(start, start + TICKET_LIST_PAGE_SIZE - 1);

  // PostgREST returns 416 for an offset beyond the filtered result set.
  // Read the count from the first row without showing that row on this page.
  const pastEnd = result.error?.code === "PGRST103" && page > 1;
  const count = pastEnd ? await query.range(0, 0) : result;
  if (count.error || count.count === null) throw new Error("Could not load staff tickets");

  const parsed = rowSchema.array().safeParse(pastEnd ? [] : result.data);
  if (!parsed.success) throw new Error("Unexpected staff ticket data");
  const rows = parsed.data.map((row) => ({
    id: row.id,
    ticketNumber: row.ticket_number,
    helpdeskNumber: row.helpdesk?.number ?? null,
    pipelineStatus: row.status,
    helpdeskState: row.helpdesk?.state ?? null,
    priority: row.helpdesk?.priority ?? row.triage?.priority ?? null,
    category: row.helpdesk?.category ?? row.triage?.category ?? null,
    assigneeName: row.helpdesk?.assignee?.display_name ?? null,
    redactedTitle: row.redaction?.redacted_title ?? null,
    createdAt: row.created_at,
  }));
  return {
    rows,
    total: count.count,
    page,
    pageCount: Math.max(1, Math.ceil(count.count / TICKET_LIST_PAGE_SIZE)),
  };
}
