import { z } from "zod";
import type { DbClient } from "./client.js";
import { DbError } from "./errors.js";

const timestamp = z.iso.datetime({ offset: true });

export const ticketSchema = z.object({
  id: z.uuid(),
  source: z.enum(["web", "email"]),
  raw_title: z.string(),
  raw_description: z.string(),
  requester_email: z.string(),
  requester_name: z.string().nullable(),
  department: z.string().nullable(),
  status: z.string(),
  servicenow_sys_id: z.string().nullable(),
  servicenow_number: z.string().nullable(),
  idempotency_key: z.string(),
  created_at: timestamp,
});

export const ticketEventSchema = z.object({
  id: z.number().int(),
  ticket_id: z.uuid(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  at: timestamp,
});

export const redactionSchema = z.object({
  ticket_id: z.uuid(),
  redacted_title: z.string(),
  redacted_description: z.string(),
  redaction_log: z.array(z.object({ type: z.string(), count: z.number().int() })),
  created_at: timestamp,
});

export const triageSchema = z.object({
  ticket_id: z.uuid(),
  sensitive: z.boolean(),
  sensitive_flags: z.array(z.string()),
  checker: z.string(),
  created_at: timestamp,
});

export type Ticket = z.infer<typeof ticketSchema>;
export type TicketEvent = z.infer<typeof ticketEventSchema>;
export type Redaction = z.infer<typeof redactionSchema>;
export type Triage = z.infer<typeof triageSchema>;

export type NewTicket = Pick<
  Ticket,
  "source" | "raw_title" | "raw_description" | "requester_email" | "idempotency_key"
> &
  Partial<Pick<Ticket, "requester_name" | "department">>;
export type NewRedaction = Omit<Redaction, "created_at">;
export type NewTriage = Omit<Triage, "created_at">;

interface SupabaseResult {
  data: unknown;
  error: { code: string } | null;
}

const UNIQUE_VIOLATION = "23505";

function supabaseError(operation: string, error: { code: string }): DbError {
  const code = error.code || undefined;
  return new DbError(operation, `supabase error ${code ?? "(no code)"}`, code);
}

/** Throws DbError on a Supabase error, then validates the row with zod. */
function parseRow<T>(operation: string, schema: z.ZodType<T>, result: SupabaseResult): T {
  if (result.error) throw supabaseError(operation, result.error);
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    // Paths only: issue messages can quote the offending values.
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
    throw new DbError(operation, `unexpected response shape at ${paths.join(", ")}`);
  }
  return parsed.data;
}

export function createRepositories(client: DbClient) {
  return {
    /** Inserts a ticket. A duplicate idempotency_key returns the existing row with created: false. */
    async createTicket(input: NewTicket): Promise<{ ticket: Ticket; created: boolean }> {
      const op = "createTicket";
      const inserted = await client.from("tickets").insert(input).select().single();
      if (inserted.error?.code !== UNIQUE_VIOLATION) {
        return { ticket: parseRow(op, ticketSchema, inserted), created: true };
      }
      const existing = await client
        .from("tickets")
        .select()
        .eq("idempotency_key", input.idempotency_key)
        .single();
      return { ticket: parseRow(op, ticketSchema, existing), created: false };
    },

    /** Returns the ticket, or null when no ticket has this id. */
    async getTicket(id: string): Promise<Ticket | null> {
      const result = await client.from("tickets").select().eq("id", id).maybeSingle();
      return parseRow("getTicket", ticketSchema.nullable(), result);
    },

    /** Appends an audit event (ticket_events is append-only). */
    async addEvent(
      ticketId: string,
      type: string,
      payload: Record<string, unknown> = {},
    ): Promise<TicketEvent> {
      const result = await client
        .from("ticket_events")
        .insert({ ticket_id: ticketId, type, payload })
        .select()
        .single();
      return parseRow("addEvent", ticketEventSchema, result);
    },

    /** Saves the redacted copy; upserts by ticket_id so a task retry is safe. */
    async saveRedaction(input: NewRedaction): Promise<Redaction> {
      const result = await client
        .from("ticket_redactions")
        .upsert(input, { onConflict: "ticket_id" })
        .select()
        .single();
      return parseRow("saveRedaction", redactionSchema, result);
    },

    /** Saves the triage result; upserts by ticket_id (one row per ticket). */
    async saveTriage(input: NewTriage): Promise<Triage> {
      const result = await client
        .from("triage_results")
        .upsert(input, { onConflict: "ticket_id" })
        .select()
        .single();
      return parseRow("saveTriage", triageSchema, result);
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
