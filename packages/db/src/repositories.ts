import {
  assertHelpdeskTransition,
  assertTransition,
  CATEGORIES,
  HELPDESK_STATES,
  NOTIFICATION_KINDS,
  PRIORITIES,
  slackUserId as slackUserIdRule,
  ticketNumberSchema,
  triageResultSchema,
  type AiUsage,
  type Category,
  type HelpdeskState,
  type InternalTicketView,
  type KbArticle,
  type NotificationKind,
  type Priority,
  type TicketStatus,
  type TriageResult,
} from "@ai-it-support/shared";
import { z } from "zod";
import type { DbClient } from "./client.js";
import {
  DbError,
  HelpdeskConflictError,
  IncidentConflictError,
  StatusConflictError,
} from "./errors.js";

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
  // The helpdesk the ticket lives in (0007, G2); null until a helpdesk ticket exists.
  // Optional, so a row read before 0007 still parses.
  helpdesk: z.enum(["servicenow", "builtin"]).nullable().optional(),
  idempotency_key: z.string(),
  is_test: z.boolean(),
  // Filled by the database default (0006); intake reads it back and never sends it.
  ticket_number: ticketNumberSchema,
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
  // Phase-3 triage columns (migration 0003): all null on a phase-2 row.
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  priority: z.string().nullable(),
  urgency: z.string().nullable(),
  assignment_group: z.string().nullable(),
  route: z.string().nullable(),
  probabilities: z.record(z.string(), z.number()).nullable(),
  flags: z.array(z.string()).nullable(),
  grounding_score: z.number().nullable(),
  kb_article_ids: z.array(z.string()).nullable(),
  suggested_fix: z.record(z.string(), z.json()).nullable(),
  model_versions: z.record(z.string(), z.string()).nullable(),
  triaged_at: timestamp.nullable(),
});

// The sensitive-check columns that saveTriage writes and returns (phase 2).
const sensitiveCheckSchema = triageSchema.pick({
  ticket_id: true,
  sensitive: true,
  sensitive_flags: true,
  checker: true,
  created_at: true,
});

export const kbSearchResultSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  content: z.string(),
  category: z.string(),
  assignment_group: z.string(),
  rank: z.number(),
});

// Stored rows are not held to the seed-quality bounds of kbArticleSchema: the
// database has no length limits, so a short or long row must still be readable.
export const kbArticleRowSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  content: z.string(),
  category: z.string(),
  assignment_group: z.string(),
});

export const reviewSchema = z.object({
  id: z.uuid(),
  ticket_id: z.uuid(),
  kind: z.enum(["triage", "autofix"]),
  proposal_id: z.uuid().nullable(),
  slack_user_id: z.string().nullable(),
  decision: z.enum(["approve", "reject", "timeout"]).nullable(),
  decided_at: timestamp.nullable(),
  wait_token_id: z.string(),
  slack_ts: z.string().nullable(),
  created_at: timestamp,
});

// The built-in helpdesk rows (migration 0007). Strict: a column the database
// returns beyond the named ones is a DbError, not silently dropped.
export const helpdeskTicketSchema = z.strictObject({
  id: z.uuid(),
  ticket_id: z.uuid(),
  seq: z.number().int(),
  number: z.string().regex(/^HD[0-9]{7}$/),
  state: z.enum(HELPDESK_STATES),
  priority: z.enum(PRIORITIES),
  category: z.enum(CATEGORIES),
  assignee_id: z.uuid().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});

export const helpdeskNoteSchema = z.strictObject({
  id: z.uuid(),
  helpdesk_ticket_id: z.uuid(),
  author_kind: z.enum(["system", "staff"]),
  author_staff_id: z.uuid().nullable(),
  body: z.string(),
  created_at: timestamp,
});

// A requester reply (migration 0006): one row per ticket, channel and kind. Strict:
// a column the database returns beyond the named ones is a DbError, not silently dropped.
const NOTIFICATION_STATUSES = ["sent", "skipped", "failed"] as const;
const NOTIFICATION_REASONS = ["not_allow_listed", "provider_error"] as const;
export const notificationSchema = z.strictObject({
  id: z.uuid(),
  ticket_id: z.uuid(),
  channel: z.enum(["email"]),
  kind: z.enum(NOTIFICATION_KINDS),
  status: z.enum(NOTIFICATION_STATUSES),
  provider_id: z.string().nullable(),
  reason: z.enum(NOTIFICATION_REASONS).nullable(),
  at: timestamp,
});

const kbTitleSchema = kbArticleRowSchema.pick({ id: true, slug: true, title: true });

export const aiReservationSchema = z.object({
  allowed: z.boolean(),
  used_calls: z.number().int(),
  call_id: z.uuid().nullable(),
});

export type Ticket = z.infer<typeof ticketSchema>;
export type TicketEvent = z.infer<typeof ticketEventSchema>;
export type Redaction = z.infer<typeof redactionSchema>;
export type Triage = z.infer<typeof triageSchema>;

export type Review = z.infer<typeof reviewSchema>;
export type ReviewDecision = NonNullable<Review["decision"]>;
export type KbArticleTitle = z.infer<typeof kbTitleSchema>;

export type Notification = z.infer<typeof notificationSchema>;
export type NotificationStatus = Notification["status"];
export type NotificationReason = NonNullable<Notification["reason"]>;
export interface NewNotification {
  ticketId: string;
  channel: "email";
  kind: NotificationKind;
  status: NotificationStatus;
  /** The provider's message id: required for `sent`, `null` otherwise. */
  providerId: string | null;
  /** `not_allow_listed` for `skipped`, `provider_error` for `failed`, `null` for `sent`. */
  reason: NotificationReason | null;
}

export type HelpdeskTicket = z.infer<typeof helpdeskTicketSchema>;
export type HelpdeskNote = z.infer<typeof helpdeskNoteSchema>;
export type NewHelpdeskTicket = { ticketId: string; priority: Priority; category: Category };

export type KbSearchResult = z.infer<typeof kbSearchResultSchema>;
export type KbArticleRow = z.infer<typeof kbArticleRowSchema>;

export type NewTicket = Pick<
  Ticket,
  "source" | "raw_title" | "raw_description" | "requester_email" | "idempotency_key"
> &
  Partial<Pick<Ticket, "requester_name" | "department" | "is_test">>;
export type NewRedaction = Omit<Redaction, "created_at">;
export type NewTriage = Pick<Triage, "ticket_id" | "sensitive" | "sensitive_flags" | "checker">;
export type SensitiveCheck = z.infer<typeof sensitiveCheckSchema>;

// Named columns for the internal ticket view. The raw title, raw description,
// requester name, requester email and department are never in these lists.
const VIEW_TICKET_COLUMNS =
  "id,ticket_number,status,is_test,source,created_at,servicenow_number,servicenow_sys_id";
const VIEW_REDACTION_COLUMNS = "redacted_title,redacted_description";
const VIEW_TRIAGE_COLUMNS =
  "sensitive,sensitive_flags,category,subcategory,priority,urgency,assignment_group,route," +
  "flags,probabilities,grounding_score,kb_article_ids,suggested_fix,model_versions,triaged_at";
const VIEW_EVENT_COLUMNS = "type,at";
const VIEW_EVENT_LIMIT = 500;
// The reviews view for the internal API: wait_token_id is never in this list.
const VIEW_REVIEW_COLUMNS = "id,kind,slack_user_id,decision,decided_at,slack_ts,created_at";
const VIEW_REVIEW_LIMIT = 100;
// The full row for the review functions (the decision handler needs wait_token_id).
const REVIEW_COLUMNS =
  "id,ticket_id,kind,proposal_id,slack_user_id,decision,decided_at,wait_token_id,slack_ts,created_at";
const HELPDESK_TICKET_COLUMNS =
  "id,ticket_id,seq,number,state,priority,category,assignee_id,created_at,updated_at";
const HELPDESK_NOTE_COLUMNS = "id,helpdesk_ticket_id,author_kind,author_staff_id,body,created_at";
const HELPDESK_NOTE_MAX_CHARS = 5000;
const NOTIFICATION_COLUMNS = "id,ticket_id,channel,kind,status,provider_id,reason,at";
const KB_TITLE_COLUMNS = "id,slug,title";
const KB_ARTICLE_COLUMNS = "id,slug,title,content,category,assignment_group";
const SECURITY_EVENT_COLUMNS = "source,kind,window_start,count";
const MAX_SECURITY_EVENTS = 500;

const viewTicketSchema = z
  .object({
    id: z.uuid(),
    ticket_number: ticketNumberSchema,
    status: z.string(),
    is_test: z.boolean(),
    source: z.string(),
    created_at: timestamp,
    servicenow_number: z.string().nullable(),
    servicenow_sys_id: z.string().nullable(),
  })
  // P5-T5b: the view's `incident` is the pair or null, so a row with only one
  // of the two columns is a shape error, not a half incident.
  .refine(
    (row) =>
      (row.servicenow_number === null) === (row.servicenow_sys_id === null) &&
      (row.servicenow_number === null ||
        (INCIDENT_NUMBER.test(row.servicenow_number) && SYS_ID.test(row.servicenow_sys_id ?? ""))),
    { path: ["incident"], message: "servicenow_number and servicenow_sys_id must be set together" },
  );
const viewRedactionSchema = z.object({
  redacted_title: z.string(),
  redacted_description: z.string(),
});
const viewTriageSchema = z.object({
  sensitive: z.boolean(),
  sensitive_flags: z.array(z.string()),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  priority: z.string().nullable(),
  urgency: z.string().nullable(),
  assignment_group: z.string().nullable(),
  route: z.string().nullable(),
  flags: z.array(z.string()).nullable(),
  probabilities: z.record(z.string(), z.number()).nullable(),
  grounding_score: z.number().nullable(),
  kb_article_ids: z.array(z.string()).nullable(),
  suggested_fix: z.record(z.string(), z.json()).nullable(),
  model_versions: z.record(z.string(), z.string()).nullable(),
  triaged_at: timestamp.nullable(),
});
const viewReviewSchema = reviewSchema.pick({
  id: true,
  kind: true,
  slack_user_id: true,
  decision: true,
  decided_at: true,
  slack_ts: true,
  created_at: true,
});
const viewEventSchema = z.object({ type: z.string(), at: timestamp });
const securityEventRowSchema = z.object({
  source: z.string(),
  kind: z.string(),
  window_start: timestamp,
  count: z.number().int(),
});
const usageRowSchema = z.object({
  provider: z.string(),
  calls: z.coerce.number(),
  tokens_in: z.coerce.number().nullable(),
  tokens_out: z.coerce.number().nullable(),
  cost_usd: z.coerce.number().nullable(),
});

type ViewTriage = NonNullable<InternalTicketView["triage"]>;

export interface SecurityEventRow {
  source: string;
  kind: string;
  windowStart: string;
  count: number;
}
export interface AiUsageMonth {
  llm: AiUsage;
  typesafe: AiUsage;
}

export type AiProvider = "llm" | "typesafe";

export interface AiReservationInput {
  provider: AiProvider;
  kind: string;
  /** Calls to reserve (an LLM request or a TypeSafe question is 1). Integer, 1..INT32_MAX. */
  calls: number;
  /** Monthly cap for the provider. Integer, 0..INT32_MAX. 0 refuses every call. */
  capCalls: number;
  environment: string;
  ticketId?: string | undefined;
  estCost?: number | undefined;
}

export interface AiReservation {
  allowed: boolean;
  /** Calls used this UTC month: including this reservation when allowed, before it when refused. */
  usedCalls: number;
  /** The reserved ai_calls row; null exactly when the reservation was refused. */
  callId: string | null;
}

export interface AiTokenUsage {
  tokensIn: number;
  tokensOut: number;
}

const INT32_MAX = 2_147_483_647;
const AI_PROVIDERS: readonly string[] = ["llm", "typesafe"];

interface SupabaseResult {
  data: unknown;
  error: { code: string } | null;
}

const UNIQUE_VIOLATION = "23505";
const REVIEW_DECISIONS: readonly string[] = ["approve", "reject", "timeout"];
const HELPDESK_KINDS = ["servicenow", "builtin"] as const;
export type HelpdeskKind = (typeof HELPDESK_KINDS)[number];
// A Slack user ID: the one shared rule (packages/shared env.ts), also used by the reviewer allow-list.
const SLACK_USER_ID = slackUserIdRule();
const uuidSchema = z.uuid();
const PROBE_TIMEOUT_MS = 3000;

// The 0007 tables and columns, and the 0008 functions, with arguments that name no row.
const BUILTIN_PROBE_COLUMNS = [
  ["staff", "id"],
  ["helpdesk_tickets", "id"],
  ["helpdesk_notes", "id"],
  ["helpdesk_assignments", "id"],
  ["helpdesk_state_transitions", "from_state"],
  ["tickets", "helpdesk"],
  ["reviews", "staff_id"],
] as const;
const NO_ROW = "00000000-0000-4000-8000-000000000000";
const BUILTIN_PROBE_FUNCTIONS: Record<string, Record<string, string>> = {
  current_staff: {},
  is_staff: {},
  is_admin: {},
  staff_add_note: { helpdesk_ticket_id: NO_ROW, body: "probe" },
  staff_assign: { helpdesk_ticket_id: NO_ROW, assignee_id: NO_ROW },
  staff_set_state: { helpdesk_ticket_id: NO_ROW, to_state: "closed" },
};

export interface SchemaProbe {
  database: boolean;
  migration0003: boolean;
  migration0005: boolean;
}
// The kb_search RPC clamps p_limit to this range; searchKb does the same.
const KB_SEARCH_MIN_LIMIT = 1;
const KB_SEARCH_MAX_LIMIT = 20;

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

// The provider message id: the same rule as the Resend client applies to its reply.
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SYS_ID = /^[0-9a-f]{32}$/;
const INCIDENT_NUMBER = /^[A-Za-z0-9]{1,40}$/;

function assertUuid(operation: string, name: string, value: unknown): asserts value is string {
  if (!uuidSchema.safeParse(value).success)
    throw new TypeError(`${operation}: ${name} must be a UUID`);
}

function assertText(operation: string, name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${operation}: ${name} must be a non-empty string`);
  }
}

/** The same rules as the 0006 row checks, applied before any request. */
function assertNewNotification(op: string, input: NewNotification): void {
  assertUuid(op, "ticketId", input.ticketId);
  if (input.channel !== "email") throw new TypeError(`${op}: unknown channel`);
  if (!(NOTIFICATION_KINDS as readonly unknown[]).includes(input.kind)) {
    throw new TypeError(`${op}: unknown kind`);
  }
  if (!(NOTIFICATION_STATUSES as readonly unknown[]).includes(input.status)) {
    throw new TypeError(`${op}: unknown status`);
  }
  const { status, providerId, reason } = input;
  if (status === "sent") {
    if (typeof providerId !== "string" || !PROVIDER_ID.test(providerId)) {
      throw new TypeError(`${op}: a sent notification needs a provider id`);
    }
    if (reason !== null) throw new TypeError(`${op}: a sent notification has no reason`);
    return;
  }
  if (providerId !== null) throw new TypeError(`${op}: only a sent notification has a provider id`);
  const wanted = status === "skipped" ? "not_allow_listed" : "provider_error";
  if (reason !== wanted) throw new TypeError(`${op}: a ${status} notification needs ${wanted}`);
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

    /**
     * The distinct event types the ticket already has, out of `types` (no
     * payloads are read). Lets a retried task skip events it already wrote.
     */
    async listEventTypes(ticketId: string, types: readonly string[]): Promise<string[]> {
      if (types.length === 0) return [];
      const result = await client
        .from("ticket_events")
        .select("type")
        .eq("ticket_id", ticketId)
        .in("type", [...types]);
      const rows = parseRow("listEventTypes", z.array(z.object({ type: z.string() })), result);
      return [...new Set(rows.map((row) => row.type))];
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

    /**
     * Counts one security event (RPC security_event_record; one row per
     * source/kind/minute) and returns the new count of that minute's row.
     */
    async recordSecurityEvent(
      source: string,
      kind: string,
      sample: Record<string, unknown>,
    ): Promise<number> {
      const result = await client.rpc("security_event_record", {
        p_source: source,
        p_kind: kind,
        p_sample: sample,
      });
      return parseRow("recordSecurityEvent", z.number().int().min(1), result);
    },

    /**
     * Reserves AI calls against the monthly cap (RPC `ai_budget_reserve`).
     * Returns `allowed: false` with no row when the cap would be exceeded.
     *
     * ISOLATION: this must stay a plain RPC call at the default READ COMMITTED
     * level. The function's post-lock sum is only correct under READ COMMITTED;
     * under REPEATABLE READ or SERIALIZABLE the cap can be overspent (the
     * function raises 25001 then). Never wrap this call in a stricter transaction.
     */
    async reserveAiCall(input: AiReservationInput): Promise<AiReservation> {
      const op = "reserveAiCall";
      if (!AI_PROVIDERS.includes(input.provider)) throw new RangeError(`${op}: unknown provider`);
      if (!Number.isInteger(input.calls) || input.calls < 1 || input.calls > INT32_MAX) {
        throw new RangeError(`${op}: calls must be an integer from 1 to ${INT32_MAX}`);
      }
      if (!Number.isInteger(input.capCalls) || input.capCalls < 0 || input.capCalls > INT32_MAX) {
        throw new RangeError(`${op}: capCalls must be an integer from 0 to ${INT32_MAX}`);
      }
      const result = await client.rpc("ai_budget_reserve", {
        p_provider: input.provider,
        p_est_cost: input.estCost ?? null,
        p_est_calls: input.calls,
        p_cap_calls: input.capCalls,
        p_environment: input.environment,
        p_kind: input.kind,
        p_ticket_id: input.ticketId ?? null,
      });
      const [row] = parseRow(op, z.array(aiReservationSchema).length(1), result);
      if (!row || row.allowed !== (row.call_id !== null)) {
        throw new DbError(op, "unexpected response shape at call_id");
      }
      return { allowed: row.allowed, usedCalls: row.used_calls, callId: row.call_id };
    },

    /**
     * Writes the token counts onto a reserved ai_calls row. An unknown call id
     * throws DbError. Counts must be integers from 0 to INT32_MAX (RangeError).
     */
    async completeAiCall(callId: string, usage: AiTokenUsage): Promise<void> {
      const op = "completeAiCall";
      for (const count of [usage.tokensIn, usage.tokensOut]) {
        if (!Number.isInteger(count) || count < 0 || count > INT32_MAX) {
          throw new RangeError(`${op}: token counts must be integers from 0 to ${INT32_MAX}`);
        }
      }
      const result = await client
        .from("ai_calls")
        .update({ tokens_in: usage.tokensIn, tokens_out: usage.tokensOut })
        .eq("id", callId)
        .select("id");
      const rows = parseRow(op, z.array(z.object({ id: z.uuid() })), result);
      if (rows.length !== 1) throw new DbError(op, "no ai_calls row with this id");
    },

    /** Saves the triage result; upserts by ticket_id (one row per ticket). */
    async saveTriage(input: NewTriage): Promise<SensitiveCheck> {
      const result = await client
        .from("triage_results")
        .upsert(input, { onConflict: "ticket_id" })
        .select()
        .single();
      return parseRow("saveTriage", sensitiveCheckSchema, result);
    },

    /**
     * Moves a ticket to `to` with a compare-and-set: one UPDATE that matches
     * the id AND the status read just before it. Returns `changed: false`
     * without an update when the ticket is already in `to`, so a retried task
     * attempt does not fail. An illegal move throws IllegalTransitionError and
     * an unknown ticket throws DbError. When the status changed between the
     * read and the write, the ticket is read again: if it now holds `to` (a
     * parallel caller made the same move) the result is `changed: false`,
     * otherwise StatusConflictError.
     */
    async setTicketStatus(id: string, to: TicketStatus): Promise<{ changed: boolean }> {
      const op = "setTicketStatus";
      const readStatus = async (): Promise<string> => {
        const result = await client.from("tickets").select("status").eq("id", id).maybeSingle();
        const row = parseRow(op, z.object({ status: z.string() }).nullable(), result);
        if (!row) throw new DbError(op, "no ticket with this id");
        return row.status;
      };

      const current = await readStatus();
      if (current === to) return { changed: false };
      assertTransition(current as TicketStatus, to);

      const result = await client
        .from("tickets")
        .update({ status: to })
        .eq("id", id)
        .eq("status", current)
        .select("id");
      const rows = parseRow(op, z.array(z.object({ id: z.uuid() })), result);
      if (rows.length === 1) return { changed: true };
      if (rows.length > 1) throw new DbError(op, "unexpected response shape at (rows)");

      if ((await readStatus()) === to) return { changed: false };
      throw new StatusConflictError(op);
    },

    /**
     * Writes the phase-3 triage columns onto the ticket's existing
     * triage_results row and sets triaged_at. The result is validated with
     * triageResultSchema before any database call (TypeError naming field
     * paths only). sensitive, sensitive_flags and checker are never sent.
     * No triage row for the ticket throws DbError.
     */
    async saveTriageResult(ticketId: string, result: TriageResult): Promise<Triage> {
      const op = "saveTriageResult";
      const parsed = triageResultSchema.safeParse(result);
      if (!parsed.success) {
        // Paths only: issue messages can quote the offending values.
        const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
        throw new TypeError(`${op}: invalid triage result at ${paths.join(", ")}`);
      }
      const r = parsed.data;
      // Field by field, never a spread, so no other column can be written.
      const columns = {
        category: r.category,
        subcategory: r.subcategory,
        priority: r.priority,
        urgency: r.urgency,
        assignment_group: r.assignmentGroup,
        route: r.route,
        probabilities: r.probabilities,
        flags: r.flags,
        grounding_score: r.groundingScore,
        kb_article_ids: r.kbArticleIds,
        suggested_fix: r.suggestedFix,
        model_versions: r.modelVersions,
        triaged_at: new Date().toISOString(),
      };
      const updated = await client
        .from("triage_results")
        .update(columns)
        .eq("ticket_id", ticketId)
        .select();
      const rows = parseRow(op, z.array(triageSchema), updated);
      const [saved] = rows;
      if (rows.length !== 1 || !saved) {
        throw new DbError(op, "no triage_results row for this ticket");
      }
      return saved;
    },

    /** Returns the ticket's redaction, or null when it has none. */
    async getRedaction(ticketId: string): Promise<Redaction | null> {
      const result = await client
        .from("ticket_redactions")
        .select()
        .eq("ticket_id", ticketId)
        .maybeSingle();
      return parseRow("getRedaction", redactionSchema.nullable(), result);
    },

    /** Returns the ticket's triage row, or null when it has none. */
    async getTriage(ticketId: string): Promise<Triage | null> {
      const result = await client
        .from("triage_results")
        .select()
        .eq("ticket_id", ticketId)
        .maybeSingle();
      return parseRow("getTriage", triageSchema.nullable(), result);
    },

    /**
     * Read-only view for the internal API: named columns only, so the raw
     * title, raw description and requester data are never selected. Returns
     * null when no ticket has this id.
     */
    async getTicketView(id: string): Promise<InternalTicketView | null> {
      const op = "getTicketView";
      const ticketResult = await client
        .from("tickets")
        .select(VIEW_TICKET_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      const ticket = parseRow(op, viewTicketSchema.nullable(), ticketResult);
      if (!ticket) return null;

      const [redactionResult, triageResult, callsResult, eventsResult, reviewsResult] =
        await Promise.all([
          client
            .from("ticket_redactions")
            .select(VIEW_REDACTION_COLUMNS)
            .eq("ticket_id", id)
            .maybeSingle(),
          client
            .from("triage_results")
            .select(VIEW_TRIAGE_COLUMNS)
            .eq("ticket_id", id)
            .maybeSingle(),
          client.from("ai_calls").select("id", { count: "exact", head: true }).eq("ticket_id", id),
          client
            .from("ticket_events")
            .select(VIEW_EVENT_COLUMNS)
            .eq("ticket_id", id)
            .order("at", { ascending: true })
            .order("id", { ascending: true })
            .limit(VIEW_EVENT_LIMIT),
          client
            .from("reviews")
            .select(VIEW_REVIEW_COLUMNS)
            .eq("ticket_id", id)
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .limit(VIEW_REVIEW_LIMIT),
        ]);
      const redaction = parseRow(op, viewRedactionSchema.nullable(), redactionResult);
      const triage = parseRow(op, viewTriageSchema.nullable(), triageResult);
      const events = parseRow(op, z.array(viewEventSchema), eventsResult);
      const reviews = parseRow(op, z.array(viewReviewSchema), reviewsResult);
      if (callsResult.error) throw supabaseError(op, callsResult.error);

      // Fields are copied one by one, so a column the database returns
      // beyond the ones asked for can never reach the view. The enum-like
      // columns are guarded by check constraints in the database.
      return {
        id: ticket.id,
        number: ticket.ticket_number,
        status: ticket.status as InternalTicketView["status"],
        isTest: ticket.is_test,
        source: ticket.source as InternalTicketView["source"],
        createdAt: ticket.created_at,
        redacted: redaction
          ? { title: redaction.redacted_title, description: redaction.redacted_description }
          : null,
        triage: triage
          ? {
              sensitive: triage.sensitive,
              sensitiveFlags: triage.sensitive_flags,
              category: triage.category as ViewTriage["category"],
              subcategory: triage.subcategory,
              priority: triage.priority as ViewTriage["priority"],
              urgency: triage.urgency as ViewTriage["urgency"],
              assignmentGroup: triage.assignment_group as ViewTriage["assignmentGroup"],
              route: triage.route as ViewTriage["route"],
              flags: triage.flags ?? [],
              probabilities: triage.probabilities,
              groundingScore: triage.grounding_score,
              kbArticleIds: triage.kb_article_ids ?? [],
              suggestedFix: triage.suggested_fix,
              modelVersions: triage.model_versions,
              triagedAt: triage.triaged_at,
            }
          : null,
        aiCallCount: callsResult.count ?? 0,
        events: events.map((event) => ({ type: event.type, at: event.at })),
        reviews: reviews.map((review) => ({
          id: review.id,
          kind: review.kind,
          decision: review.decision,
          decidedBy: review.slack_user_id,
          decidedAt: review.decided_at,
          slackTs: review.slack_ts,
          createdAt: review.created_at,
        })),
        notifications: [],
        autofix: [],
        incident:
          ticket.servicenow_number === null || ticket.servicenow_sys_id === null
            ? null
            : { number: ticket.servicenow_number, sysId: ticket.servicenow_sys_id },
      };
    },

    /**
     * Inserts the ticket's triage review. A ticket has at most one (unique key
     * on ticket, kind and proposal): on a duplicate the existing row is
     * returned unchanged and the new `waitTokenId` is not stored. Any other
     * database error throws DbError.
     */
    async createTriageReview(input: { ticketId: string; waitTokenId: string }): Promise<Review> {
      const op = "createTriageReview";
      assertUuid(op, "ticketId", input.ticketId);
      assertText(op, "waitTokenId", input.waitTokenId);
      const inserted = await client
        .from("reviews")
        .insert({ ticket_id: input.ticketId, kind: "triage", wait_token_id: input.waitTokenId })
        .select(REVIEW_COLUMNS)
        .single();
      if (inserted.error?.code !== UNIQUE_VIOLATION) return parseRow(op, reviewSchema, inserted);
      const existing = await client
        .from("reviews")
        .select(REVIEW_COLUMNS)
        .eq("ticket_id", input.ticketId)
        .eq("kind", "triage")
        .is("proposal_id", null)
        .single();
      return parseRow(op, reviewSchema, existing);
    },

    /** Returns the review, or null when no review has this id. Non-UUID: TypeError. */
    async getReview(id: string): Promise<Review | null> {
      const op = "getReview";
      assertUuid(op, "id", id);
      const result = await client.from("reviews").select(REVIEW_COLUMNS).eq("id", id).maybeSingle();
      return parseRow(op, reviewSchema.nullable(), result);
    },

    /** Returns the ticket's triage review, or null when it has none. Non-UUID: TypeError. */
    async getTriageReview(ticketId: string): Promise<Review | null> {
      const op = "getTriageReview";
      assertUuid(op, "ticketId", ticketId);
      const result = await client
        .from("reviews")
        .select(REVIEW_COLUMNS)
        .eq("ticket_id", ticketId)
        .eq("kind", "triage")
        .is("proposal_id", null)
        .maybeSingle();
      return parseRow(op, reviewSchema.nullable(), result);
    },

    /**
     * Records the Slack message timestamp of the review card, only while
     * `slack_ts` is still null (one conditional UPDATE). `changed: false`
     * when it was already set (the stored value is kept) or the id is unknown.
     */
    async setReviewSlackTs(id: string, ts: string): Promise<{ changed: boolean }> {
      const op = "setReviewSlackTs";
      assertUuid(op, "id", id);
      assertText(op, "ts", ts);
      const result = await client
        .from("reviews")
        .update({ slack_ts: ts })
        .eq("id", id)
        .is("slack_ts", null)
        .select("id");
      const rows = parseRow(op, z.array(z.object({ id: z.uuid() })), result);
      if (rows.length > 1) throw new DbError(op, "unexpected response shape at (rows)");
      return { changed: rows.length === 1 };
    },

    /**
     * Records a review decision with ONE conditional UPDATE (`where decision
     * is null`), so exactly one of any number of parallel callers wins. The
     * winner gets `changed: true`; everyone else gets `changed: false` and the
     * stored row. `timeout` needs `slackUserId` null; `approve` and `reject`
     * need a Slack user ID (`U` or `W` plus 8 to 12 capitals or digits). Anything
     * else throws a TypeError before any database call. An unknown id throws DbError.
     */
    async decideReview(
      id: string,
      decision: ReviewDecision,
      slackUserId: string | null,
    ): Promise<{ changed: boolean; review: Review }> {
      const op = "decideReview";
      assertUuid(op, "id", id);
      if (!REVIEW_DECISIONS.includes(decision)) throw new TypeError(`${op}: unknown decision`);
      if (decision === "timeout") {
        if (slackUserId !== null) throw new TypeError(`${op}: a timeout has no Slack user`);
      } else if (typeof slackUserId !== "string" || !SLACK_USER_ID.safeParse(slackUserId).success) {
        throw new TypeError(`${op}: ${decision} needs a Slack user ID`);
      }
      const result = await client
        .from("reviews")
        .update({ decision, decided_at: new Date().toISOString(), slack_user_id: slackUserId })
        .eq("id", id)
        .is("decision", null)
        .select(REVIEW_COLUMNS);
      const rows = parseRow(op, z.array(reviewSchema), result);
      const [won] = rows;
      if (rows.length > 1) throw new DbError(op, "unexpected response shape at (rows)");
      if (won) return { changed: true, review: won };

      // Lost the race, or the id is unknown: read what is stored.
      const read = await client.from("reviews").select(REVIEW_COLUMNS).eq("id", id).maybeSingle();
      const stored = parseRow(op, reviewSchema.nullable(), read);
      if (!stored) throw new DbError(op, "no reviews row with this id");
      return { changed: false, review: stored };
    },

    /**
     * Inserts the ticket's built-in helpdesk ticket. A ticket has at most one
     * (unique key on ticket_id): on a duplicate the existing row is returned
     * unchanged with created: false, so a retry gets the same row and number.
     * A non-UUID id, priority or category is a TypeError before any request.
     */
    async createHelpdeskTicket(
      input: NewHelpdeskTicket,
    ): Promise<{ helpdeskTicket: HelpdeskTicket; created: boolean }> {
      const op = "createHelpdeskTicket";
      assertUuid(op, "ticketId", input.ticketId);
      if (!(PRIORITIES as readonly unknown[]).includes(input.priority)) {
        throw new TypeError(`${op}: unknown priority`);
      }
      if (!(CATEGORIES as readonly unknown[]).includes(input.category)) {
        throw new TypeError(`${op}: unknown category`);
      }
      const inserted = await client
        .from("helpdesk_tickets")
        .insert({ ticket_id: input.ticketId, priority: input.priority, category: input.category })
        .select(HELPDESK_TICKET_COLUMNS)
        .single();
      if (inserted.error?.code !== UNIQUE_VIOLATION) {
        return { helpdeskTicket: parseRow(op, helpdeskTicketSchema, inserted), created: true };
      }
      const existing = await client
        .from("helpdesk_tickets")
        .select(HELPDESK_TICKET_COLUMNS)
        .eq("ticket_id", input.ticketId)
        .single();
      return { helpdeskTicket: parseRow(op, helpdeskTicketSchema, existing), created: false };
    },

    /** Returns the ticket's helpdesk ticket, or null when it has none. Non-UUID: TypeError. */
    async getHelpdeskTicketByTicketId(ticketId: string): Promise<HelpdeskTicket | null> {
      const op = "getHelpdeskTicketByTicketId";
      assertUuid(op, "ticketId", ticketId);
      const result = await client
        .from("helpdesk_tickets")
        .select(HELPDESK_TICKET_COLUMNS)
        .eq("ticket_id", ticketId)
        .maybeSingle();
      return parseRow(op, helpdeskTicketSchema.nullable(), result);
    },

    /** Returns the helpdesk ticket with this row id, or null when there is none. Non-UUID: TypeError. */
    async getHelpdeskTicket(id: string): Promise<HelpdeskTicket | null> {
      const op = "getHelpdeskTicket";
      assertUuid(op, "id", id);
      const result = await client
        .from("helpdesk_tickets")
        .select(HELPDESK_TICKET_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      return parseRow(op, helpdeskTicketSchema.nullable(), result);
    },

    /**
     * Appends a note written by the system (author_kind `system`, no staff).
     * `body` is 1 to 5000 characters, counted as the database counts them;
     * a blank body is a TypeError and a longer one a RangeError, both before
     * any request. The body is never echoed in an error.
     */
    async addSystemNote(helpdeskTicketId: string, body: string): Promise<HelpdeskNote> {
      const op = "addSystemNote";
      assertUuid(op, "helpdeskTicketId", helpdeskTicketId);
      assertText(op, "body", body);
      if ([...body].length > HELPDESK_NOTE_MAX_CHARS) {
        throw new RangeError(`${op}: body must be at most ${HELPDESK_NOTE_MAX_CHARS} characters`);
      }
      const result = await client
        .from("helpdesk_notes")
        .insert({ helpdesk_ticket_id: helpdeskTicketId, author_kind: "system", body })
        .select(HELPDESK_NOTE_COLUMNS)
        .single();
      return parseRow(op, helpdeskNoteSchema, result);
    },

    /**
     * Moves a helpdesk ticket from `from` to `to` with a compare-and-set: ONE
     * UPDATE that matches the id AND `state = from`. An illegal pair, or a value
     * that is not a helpdesk state, throws IllegalHelpdeskTransitionError before
     * any request. The winner gets `changed: true` and the new row. When the
     * stored state is not `from` (stale), nothing is written and the result is
     * `changed: false` with the stored row. An unknown id throws DbError.
     */
    async setHelpdeskState(
      id: string,
      from: HelpdeskState,
      to: HelpdeskState,
    ): Promise<{ changed: boolean; helpdeskTicket: HelpdeskTicket }> {
      const op = "setHelpdeskState";
      assertUuid(op, "id", id);
      assertHelpdeskTransition(from, to);
      const result = await client
        .from("helpdesk_tickets")
        .update({ state: to, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("state", from)
        .select(HELPDESK_TICKET_COLUMNS);
      const rows = parseRow(op, z.array(helpdeskTicketSchema), result);
      const [won] = rows;
      if (rows.length > 1) throw new DbError(op, "unexpected response shape at (rows)");
      if (won) return { changed: true, helpdeskTicket: won };

      // Stale `from`, or the id is unknown: read what is stored.
      const read = await client
        .from("helpdesk_tickets")
        .select(HELPDESK_TICKET_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      const stored = parseRow(op, helpdeskTicketSchema.nullable(), read);
      if (!stored) throw new DbError(op, "no helpdesk_tickets row with this id");
      return { changed: false, helpdeskTicket: stored };
    },

    /**
     * Records which helpdesk the ticket lives in (G2), only while it is still
     * null (one conditional UPDATE). `changed: false` when it already holds
     * the same value. A different stored value throws HelpdeskConflictError
     * and an unknown ticket DbError; nothing is overwritten.
     */
    async setTicketHelpdesk(ticketId: string, kind: HelpdeskKind): Promise<{ changed: boolean }> {
      const op = "setTicketHelpdesk";
      assertUuid(op, "ticketId", ticketId);
      if (!(HELPDESK_KINDS as readonly unknown[]).includes(kind)) {
        throw new TypeError(`${op}: unknown helpdesk`);
      }
      const result = await client
        .from("tickets")
        .update({ helpdesk: kind })
        .eq("id", ticketId)
        .is("helpdesk", null)
        .select("id");
      const rows = parseRow(op, z.array(z.object({ id: z.uuid() })), result);
      if (rows.length > 1) throw new DbError(op, "unexpected response shape at (rows)");
      if (rows.length === 1) return { changed: true };

      const read = await client.from("tickets").select("helpdesk").eq("id", ticketId).maybeSingle();
      const stored = parseRow(
        op,
        z.object({ helpdesk: z.enum(HELPDESK_KINDS).nullable() }).nullable(),
        read,
      );
      if (!stored) throw new DbError(op, "no ticket with this id");
      // The update matched nothing, so a null here is not a state a caller can act on.
      if (stored.helpdesk === null) throw new DbError(op, "unexpected response shape at helpdesk");
      if (stored.helpdesk !== kind) throw new HelpdeskConflictError(op);
      return { changed: false };
    },

    /**
     * Inserts the reply notification of a ticket (P5-T8b). A ticket has at most
     * one per channel and kind (unique key): on a duplicate the stored row is
     * returned unchanged with created: false, and nothing is updated, so a
     * sent row can never be overwritten by a later failed or skipped one. The
     * values are checked like the 0006 row checks, before any request
     * (TypeError, naming no value).
     */
    async recordNotification(
      input: NewNotification,
    ): Promise<{ created: boolean; notification: Notification }> {
      const op = "recordNotification";
      assertNewNotification(op, input);
      const inserted = await client
        .from("notifications")
        .insert({
          ticket_id: input.ticketId,
          channel: input.channel,
          kind: input.kind,
          status: input.status,
          provider_id: input.providerId,
          reason: input.reason,
        })
        .select(NOTIFICATION_COLUMNS)
        .single();
      if (inserted.error?.code !== UNIQUE_VIOLATION) {
        return { created: true, notification: parseRow(op, notificationSchema, inserted) };
      }
      const existing = await client
        .from("notifications")
        .select(NOTIFICATION_COLUMNS)
        .eq("ticket_id", input.ticketId)
        .eq("channel", input.channel)
        .eq("kind", input.kind)
        .single();
      return { created: false, notification: parseRow(op, notificationSchema, existing) };
    },

    /** The ticket's email notification of this kind, or null when it has none. */
    async getNotification(ticketId: string, kind: NotificationKind): Promise<Notification | null> {
      const op = "getNotification";
      assertUuid(op, "ticketId", ticketId);
      if (!(NOTIFICATION_KINDS as readonly unknown[]).includes(kind)) {
        throw new TypeError(`${op}: unknown kind`);
      }
      const result = await client
        .from("notifications")
        .select(NOTIFICATION_COLUMNS)
        .eq("ticket_id", ticketId)
        .eq("channel", "email")
        .eq("kind", kind)
        .maybeSingle();
      return parseRow(op, notificationSchema.nullable(), result);
    },

    /**
     * The requester's address, for the reply task ONLY (service role, pipeline;
     * the web app and the internal view never call it). The one named column
     * is selected and the address is never part of an error. Null when no
     * ticket has this id.
     */
    async getRequesterEmail(ticketId: string): Promise<string | null> {
      const op = "getRequesterEmail";
      assertUuid(op, "ticketId", ticketId);
      const result = await client
        .from("tickets")
        .select("requester_email")
        .eq("id", ticketId)
        .maybeSingle();
      const row = parseRow(op, z.object({ requester_email: z.string() }).nullable(), result);
      return row === null ? null : row.requester_email;
    },

    /**
     * Stores the helpdesk incident of a ticket (P5-T5a), only while no sys_id is
     * set (one conditional UPDATE). `changed: false` when the ticket already
     * holds the same sys_id. A different stored sys_id throws
     * IncidentConflictError and an unknown ticket DbError; nothing is overwritten.
     */
    async setTicketIncident(
      ticketId: string,
      incident: { sysId: string; number: string },
    ): Promise<{ changed: boolean }> {
      const op = "setTicketIncident";
      assertUuid(op, "ticketId", ticketId);
      if (!SYS_ID.test(String(incident?.sysId))) {
        throw new TypeError(`${op}: sysId must be a sys_id`);
      }
      if (!INCIDENT_NUMBER.test(String(incident.number))) {
        throw new TypeError(`${op}: number must be an incident number`);
      }
      const result = await client
        .from("tickets")
        .update({ servicenow_sys_id: incident.sysId, servicenow_number: incident.number })
        .eq("id", ticketId)
        .is("servicenow_sys_id", null)
        .select("id");
      const rows = parseRow(op, z.array(z.object({ id: z.uuid() })), result);
      if (rows.length > 1) throw new DbError(op, "unexpected response shape at (rows)");
      if (rows.length === 1) return { changed: true };

      const read = await client
        .from("tickets")
        .select("servicenow_sys_id,servicenow_number")
        .eq("id", ticketId)
        .maybeSingle();
      const stored = parseRow(
        op,
        z.object({ servicenow_sys_id: z.string().nullable() }).nullable(),
        read,
      );
      if (!stored) throw new DbError(op, "no ticket with this id");
      // The update matched nothing, so a null here is not a state a caller can act on.
      if (stored.servicenow_sys_id === null) {
        throw new DbError(op, "unexpected response shape at servicenow_sys_id");
      }
      if (stored.servicenow_sys_id !== incident.sysId) throw new IncidentConflictError(op);
      return { changed: false };
    },

    /**
     * Id, slug and title of the knowledge base articles with these ids, in
     * input order. Unknown ids are left out and a repeated id is returned
     * once. An empty list makes no database call; a non-UUID is a TypeError.
     */
    async getKbArticlesByIds(ids: readonly string[]): Promise<KbArticleTitle[]> {
      const op = "getKbArticlesByIds";
      for (const id of ids) assertUuid(op, "ids", id);
      const unique = [...new Set(ids)];
      if (unique.length === 0) return [];
      const result = await client.from("kb_articles").select(KB_TITLE_COLUMNS).in("id", unique);
      const rows = parseRow(op, z.array(kbTitleSchema), result);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return unique.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
    },

    /**
     * Usage of the UTC month that contains `monthStart` (`YYYY-MM-DD`), from
     * RPC ai_usage_month. A provider without rows gets zeros and a null cost.
     */
    async getAiUsage(monthStart: string): Promise<AiUsageMonth> {
      const op = "getAiUsage";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(monthStart)) throw new DbError(op, "invalid month start");
      const result = await client.rpc("ai_usage_month", { p_month_start: monthStart });
      const rows = parseRow(op, z.array(usageRowSchema), result);
      const totals = (provider: string): AiUsage => {
        const row = rows.find((candidate) => candidate.provider === provider);
        return {
          calls: row?.calls ?? 0,
          tokensIn: row?.tokens_in ?? 0,
          tokensOut: row?.tokens_out ?? 0,
          costUsd: row?.cost_usd ?? null,
        };
      };
      return { llm: totals("llm"), typesafe: totals("typesafe") };
    },

    /**
     * Security events at or after `since`, newest first. `limit` is clamped
     * to 1-500. The `sample` column is never selected.
     */
    async listSecurityEvents(
      since: Date,
      limit = MAX_SECURITY_EVENTS,
    ): Promise<SecurityEventRow[]> {
      const bounded = Number.isFinite(limit)
        ? Math.min(MAX_SECURITY_EVENTS, Math.max(1, Math.trunc(limit)))
        : MAX_SECURITY_EVENTS;
      const result = await client
        .from("security_events")
        .select(SECURITY_EVENT_COLUMNS)
        .gte("window_start", since.toISOString())
        .order("window_start", { ascending: false })
        .order("id", { ascending: false })
        .limit(bounded);
      return parseRow("listSecurityEvents", z.array(securityEventRowSchema), result).map((row) => ({
        source: row.source,
        kind: row.kind,
        windowStart: new Date(row.window_start).toISOString(),
        count: row.count,
      }));
    },

    /**
     * Cheap schema probe for the public health endpoint. Never throws and
     * never returns error text: any failure, timeout included, is `false`.
     * `database` is a select on tickets; `migration0003` needs selects on
     * tickets.is_test, kb_articles, ai_calls and security_events to work;
     * `migration0005` needs a select on reviews.id.
     */
    async probeSchema(timeoutMs = PROBE_TIMEOUT_MS): Promise<SchemaProbe> {
      const works = async (table: string, column: string): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const query = client
            .from(table)
            .select(column)
            .limit(1)
            .abortSignal(AbortSignal.timeout(timeoutMs));
          const timeout = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          });
          const outcome = await Promise.race([Promise.resolve(query), timeout]);
          return outcome !== false && !outcome.error;
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
        }
      };

      if (!(await works("tickets", "id"))) {
        return { database: false, migration0003: false, migration0005: false };
      }
      const results = await Promise.all([
        works("tickets", "is_test"),
        works("kb_articles", "id"),
        works("ai_calls", "id"),
        works("security_events", "id"),
        works("reviews", "id"),
      ]);
      const [isTest, kbArticles, aiCalls, securityEvents, reviews] = results;
      return {
        database: true,
        migration0003: Boolean(isTest && kbArticles && aiCalls && securityEvents),
        migration0005: Boolean(reviews),
      };
    },

    /**
     * True when the built-in helpdesk's database objects exist: the 0007 tables
     * and the two columns it adds (a select each), and the 0008 functions. The
     * functions are called with an all-zero ID: the service role may not run
     * them (42501 answers before the body, so the function exists) and each
     * body refuses a caller who is not staff before it writes. Any other answer,
     * a timeout or a thrown error is false. Never throws, never returns text.
     */
    async probeBuiltinHelpdesk(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
      const within = async (work: () => PromiseLike<boolean>): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          });
          return await Promise.race([Promise.resolve(work()), timeout]);
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
        }
      };
      const reads = BUILTIN_PROBE_COLUMNS.map(([table, column]) =>
        within(async () => {
          const result = await client
            .from(table)
            .select(column)
            .limit(1)
            .abortSignal(AbortSignal.timeout(timeoutMs));
          return !result.error;
        }),
      );
      const calls = Object.entries(BUILTIN_PROBE_FUNCTIONS).map(([name, args]) =>
        within(async () => {
          const result = await client.rpc(name, args).abortSignal(AbortSignal.timeout(timeoutMs));
          return !result.error || result.error.code === "42501";
        }),
      );
      return (await Promise.all([...reads, ...calls])).every(Boolean);
    },

    /**
     * Ranked full-text search of the knowledge base (RPC `kb_search`). `query` is
     * the output of buildKbQuery; a blank query returns [] without a database
     * call. `limit` is clamped to 1..20 like the RPC; a non-integer throws a
     * RangeError and a non-string query a TypeError.
     */
    async searchKb(query: string, limit = 5): Promise<KbSearchResult[]> {
      if (typeof query !== "string") throw new TypeError("searchKb expects a string query");
      if (!Number.isInteger(limit)) throw new RangeError("searchKb expects an integer limit");
      if (query.trim() === "") return [];
      const result = await client.rpc("kb_search", {
        p_query: query,
        p_limit: Math.min(Math.max(limit, KB_SEARCH_MIN_LIMIT), KB_SEARCH_MAX_LIMIT),
      });
      return parseRow("searchKb", z.array(kbSearchResultSchema), result);
    },

    /**
     * All knowledge base articles, ordered by slug. PostgREST caps one response
     * at its max-rows setting (1000 on Supabase); the kb-ingest task accepts
     * at most 200 articles per run, so an article beyond the cap is only
     * written again, never lost.
     */
    async listKbArticles(): Promise<KbArticleRow[]> {
      const result = await client
        .from("kb_articles")
        .select(KB_ARTICLE_COLUMNS)
        .order("slug", { ascending: true });
      return parseRow("listKbArticles", z.array(kbArticleRowSchema), result);
    },

    /**
     * Inserts or updates articles by slug in ONE PostgREST request, so the
     * write is all-or-nothing. Only the five article columns are sent; the id
     * of an existing row is kept. Returns the number of rows written. Never
     * deletes. Slugs must be unique within `articles`.
     */
    async upsertKbArticles(articles: readonly KbArticle[]): Promise<number> {
      const op = "upsertKbArticles";
      if (articles.length === 0) return 0;
      const rows = articles.map((a) => ({
        slug: a.slug,
        title: a.title,
        content: a.content,
        category: a.category,
        assignment_group: a.assignment_group,
      }));
      const result = await client
        .from("kb_articles")
        .upsert(rows, { onConflict: "slug" })
        .select("slug");
      const written = parseRow(op, z.array(z.object({ slug: z.string() })), result);
      if (written.length !== rows.length)
        throw new DbError(op, "unexpected response shape at (rows)");
      return written.length;
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
