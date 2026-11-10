import type { AlertFn } from "@ai-it-support/ai";
import type { Repositories } from "@ai-it-support/db";
import type { HelpdeskConnector, HelpdeskTicketRef } from "@ai-it-support/helpdesk";
import { testOverridesSchema, type HelpdeskSyncPayload } from "@ai-it-support/shared";
import { z } from "zod";

// Payload type is shared with the caller that triggers it (packages/shared).
export const helpdeskSyncPayload = z.object({
  ticketId: z.uuid(),
  testOverrides: testOverridesSchema.optional(),
}) satisfies z.ZodType<HelpdeskSyncPayload>;

export type { HelpdeskSyncPayload };

export type HelpdeskSyncResult =
  | { ticketId: string; refused: true }
  | { ticketId: string; skipped: true }
  | { ticketId: string; shadow: true }
  | { ticketId: string; failed: true; error: string }
  | { ticketId: string; incident: HelpdeskTicketRef };

type LogFn = (message: string, data?: Record<string, unknown>) => void;

export interface HelpdeskSyncDeps {
  repos: Pick<
    Repositories,
    | "getTicket"
    | "getTriage"
    | "getRedaction"
    | "getKbArticlesByIds"
    | "setTicketStatus"
    | "setTicketIncident"
    | "listEventTypes"
    | "addEvent"
  >;
  /**
   * Builds the real connector. Called inside the run, so a config error is
   * handled like any other helpdesk error (`alert:helpdesk_config`).
   */
  createConnector: () => HelpdeskConnector;
  /** SHADOW_MODE. */
  shadowMode: boolean;
  /** E2E_MODE: test switches take effect only with it AND the ticket's is_test. */
  e2eMode: boolean;
  /** Never throws (createAlertSink). */
  alert: AlertFn;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}
