import {
  assertTransition,
  triageResultSchema,
  type AiUsage,
  type InternalTicketView,
  type KbArticle,
  type TicketStatus,
  type TriageResult,
} from "@ai-it-support/shared";
import { z } from "zod";
import type { DbClient } from "./client.js";
import { DbError, StatusConflictError } from "./errors.js";

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
  is_test: z.boolean(),
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

export const aiReservationSchema = z.object({
  allowed: z.boolean(),
  used_calls: z.number().int(),
  call_id: z.uuid().nullable(),
});

export type Ticket = z.infer<typeof ticketSchema>;
export type TicketEvent = z.infer<typeof ticketEventSchema>;
export type Redaction = z.infer<typeof redactionSchema>;
export type Triage = z.infer<typeof triageSchema>;

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
const VIEW_TICKET_COLUMNS = "id,status,is_test,source,created_at";
const VIEW_REDACTION_COLUMNS = "redacted_title,redacted_description";
const VIEW_TRIAGE_COLUMNS =
  "sensitive,sensitive_flags,category,subcategory,priority,urgency,assignment_group,route," +
  "flags,probabilities,grounding_score,kb_article_ids,suggested_fix,model_versions,triaged_at";
const VIEW_EVENT_COLUMNS = "type,at";
const VIEW_EVENT_LIMIT = 500;
const KB_ARTICLE_COLUMNS = "id,slug,title,content,category,assignment_group";
const SECURITY_EVENT_COLUMNS = "source,kind,window_start,count";
const MAX_SECURITY_EVENTS = 500;

const viewTicketSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  is_test: z.boolean(),
  source: z.string(),
  created_at: timestamp,
});
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
const PROBE_TIMEOUT_MS = 3000;

export interface SchemaProbe {
  database: boolean;
  migration0003: boolean;
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

    /** Counts one security event (RPC security_event_record; one row per source/kind/minute). */
    async recordSecurityEvent(
      source: string,
      kind: string,
      sample: Record<string, unknown>,
    ): Promise<void> {
      const result = await client.rpc("security_event_record", {
        p_source: source,
        p_kind: kind,
        p_sample: sample,
      });
      if (result.error) throw supabaseError("recordSecurityEvent", result.error);
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

      const [redactionResult, triageResult, callsResult, eventsResult] = await Promise.all([
        client
          .from("ticket_redactions")
          .select(VIEW_REDACTION_COLUMNS)
          .eq("ticket_id", id)
          .maybeSingle(),
        client.from("triage_results").select(VIEW_TRIAGE_COLUMNS).eq("ticket_id", id).maybeSingle(),
        client.from("ai_calls").select("id", { count: "exact", head: true }).eq("ticket_id", id),
        client
          .from("ticket_events")
          .select(VIEW_EVENT_COLUMNS)
          .eq("ticket_id", id)
          .order("at", { ascending: true })
          .order("id", { ascending: true })
          .limit(VIEW_EVENT_LIMIT),
      ]);
      const redaction = parseRow(op, viewRedactionSchema.nullable(), redactionResult);
      const triage = parseRow(op, viewTriageSchema.nullable(), triageResult);
      const events = parseRow(op, z.array(viewEventSchema), eventsResult);
      if (callsResult.error) throw supabaseError(op, callsResult.error);

      // Fields are copied one by one, so a column the database returns
      // beyond the ones asked for can never reach the view. The enum-like
      // columns are guarded by check constraints in the database.
      return {
        id: ticket.id,
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
        reviews: [],
        notifications: [],
        autofix: [],
      };
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
     * tickets.is_test, kb_articles, ai_calls and security_events to work.
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

      if (!(await works("tickets", "id"))) return { database: false, migration0003: false };
      const results = await Promise.all([
        works("tickets", "is_test"),
        works("kb_articles", "id"),
        works("ai_calls", "id"),
        works("security_events", "id"),
      ]);
      return { database: true, migration0003: results.every(Boolean) };
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
