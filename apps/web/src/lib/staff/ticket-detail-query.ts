import { ticketNumberSchema } from "@ai-it-support/shared";
import { z } from "zod";
import type { createServerSupabaseClient } from "@/lib/supabase/server";

type StaffClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

const staffName = z.strictObject({ display_name: z.string() }).nullable();
const timestamp = z.iso.datetime({ offset: true });
const articleSchema = z.strictObject({ slug: z.string(), title: z.string() });
const ticketSchema = z.strictObject({
  ticket_number: ticketNumberSchema,
  redaction: z
    .strictObject({ redacted_title: z.string(), redacted_description: z.string() })
    .nullable(),
  triage: z
    .strictObject({
      category: z.string().nullable(),
      priority: z.string().nullable(),
      urgency: z.string().nullable(),
      route: z.string().nullable(),
      probabilities: z.record(z.string(), z.number().min(0).max(1)).nullable(),
      sensitive_flags: z.array(z.string()),
      kb_article_ids: z.array(z.uuid()).nullable(),
      suggested_fix: z
        .object({ steps: z.array(z.string()), caveats: z.array(z.string()).optional() })
        .nullable(),
    })
    .nullable(),
  helpdesk: z
    .strictObject({
      id: z.uuid(),
      number: z.string(),
      state: z.string(),
      assignee: staffName,
    })
    .nullable(),
});
const eventSchema = z.strictObject({ id: z.number(), type: z.string(), at: timestamp });
const noteSchema = z.strictObject({
  id: z.uuid(),
  body: z.string(),
  created_at: timestamp,
  author: staffName,
});
const assignmentSchema = z.strictObject({
  id: z.uuid(),
  at: timestamp,
  assignee: staffName,
  assigned_by: staffName,
});

type HistoryEntry = { key: string; label: string; at: string; body?: string };
const HISTORY_BATCH = 250;
const DETAIL_SELECT = [
  "ticket_number",
  "redaction:ticket_redactions(redacted_title,redacted_description)",
  "triage:triage_results(category,priority,urgency,route,probabilities,sensitive_flags,kb_article_ids,suggested_fix)",
  "helpdesk:helpdesk_tickets(id,number,state,assignee:staff!helpdesk_tickets_assignee_id_fkey(display_name))",
].join(",");

function parseRows<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Unexpected staff ticket detail");
  return parsed.data;
}

// Read bounded ranges so the API row cap cannot silently cut off the timeline.
async function readHistoryRows<T>(
  schema: z.ZodType<T>,
  request: (
    start: number,
    end: number,
  ) => PromiseLike<{
    data: unknown;
    error: unknown;
    count: number | null;
  }>,
): Promise<T[]> {
  const rows: T[] = [];
  let total: number | undefined;
  const rowSchema = z.array(schema);
  do {
    const end = Math.min(rows.length + HISTORY_BATCH, total ?? Infinity) - 1;
    const { data, error, count } = await request(rows.length, end);
    if (error || count === null) throw new Error("Could not load staff ticket history");
    total ??= count;
    const batch = parseRows(rowSchema, data);
    if (!batch.length && rows.length < total) throw new Error("Incomplete staff ticket history");
    rows.push(...batch);
  } while (rows.length < total);
  return rows;
}

export async function getStaffTicket(client: StaffClient, id: string, showTestTickets: boolean) {
  const query = client.from("tickets").select(DETAIL_SELECT).eq("id", id);
  if (!showTestTickets) query.eq("is_test", false);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("Could not load staff ticket detail");
  if (data === null) return null;
  const ticket = parseRows(ticketSchema, data);
  const helpdeskId = ticket.helpdesk?.id;
  const kbArticleIds = ticket.triage?.kb_article_ids ?? [];

  const [eventRows, noteRows, assignmentRows, articles] = await Promise.all([
    readHistoryRows(eventSchema, (start, end) =>
      client
        .from("ticket_events")
        .select("id,type,at", { count: "exact" })
        .eq("ticket_id", id)
        .order("id")
        .range(start, end),
    ),
    helpdeskId
      ? readHistoryRows(noteSchema, (start, end) =>
          client
            .from("helpdesk_notes")
            .select(
              "id,body,created_at,author:staff!helpdesk_notes_author_staff_id_fkey(display_name)",
              { count: "exact" },
            )
            .eq("helpdesk_ticket_id", helpdeskId)
            .order("created_at")
            .order("id")
            .range(start, end),
        )
      : [],
    helpdeskId
      ? readHistoryRows(assignmentSchema, (start, end) =>
          client
            .from("helpdesk_assignments")
            .select(
              "id,at,assignee:staff!helpdesk_assignments_assignee_id_fkey(display_name),assigned_by:staff!helpdesk_assignments_assigned_by_staff_id_fkey(display_name)",
              { count: "exact" },
            )
            .eq("helpdesk_ticket_id", helpdeskId)
            .order("at")
            .order("id")
            .range(start, end),
        )
      : [],
    readArticleSummaries(client, kbArticleIds),
  ]);

  const history: HistoryEntry[] = [
    ...eventRows.map(({ id, type, at }) => ({
      key: `event-${id}`,
      label: type.charAt(0).toUpperCase() + type.slice(1).replaceAll("_", " "),
      at,
    })),
    ...noteRows.map(({ id, body, created_at, author }) => ({
      key: `note-${id}`,
      label: `Note by ${author?.display_name ?? "System"}`,
      body,
      at: created_at,
    })),
    ...assignmentRows.map(({ id, at, assignee, assigned_by }) => ({
      key: `assignment-${id}`,
      label: `Assigned to ${assignee?.display_name ?? "Unknown staff"}`,
      body: `Assigned by ${assigned_by?.display_name ?? "System"}`,
      at,
    })),
  ];
  history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { ...ticket, articles, history };
}

async function readArticleSummaries(client: StaffClient, ids: string[]) {
  if (!ids.length) return [];
  const { data, error } = await client
    .from("kb_articles")
    .select("slug,title")
    .in("id", ids)
    .order("slug");
  if (error) throw new Error("Could not load staff ticket articles");
  return parseRows(z.array(articleSchema), data);
}
