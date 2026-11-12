import { z } from "zod";
import { ASSIGNMENT_GROUPS, CATEGORIES, PRIORITIES, ROUTES, URGENCIES } from "./triage.js";
import { TICKET_STATUSES } from "./status.js";
import { NOTIFICATION_KINDS, ticketNumberSchema } from "./ticket.js";

const timestamp = z.iso.datetime({ offset: true });
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();

/**
 * One Slack review of a ticket. `decidedBy` is a Slack user ID, not a name.
 * The wait token behind the review is never part of the view.
 */
export const internalReviewSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["triage", "autofix"]),
  decision: nullable(z.enum(["approve", "reject", "timeout"])),
  decidedBy: nullable(z.string()),
  decidedAt: nullable(timestamp),
  slackTs: nullable(z.string()),
  createdAt: timestamp,
});

/**
 * One reply email of a ticket (P5-T8b). Seven keys, no address and no text:
 * `providerId` is the provider's message id, `reason` is a fixed word.
 */
export const internalNotificationSchema = z.strictObject({
  id: z.uuid(),
  channel: z.enum(["email"]),
  kind: z.enum(NOTIFICATION_KINDS),
  status: z.enum(["sent", "skipped", "failed"]),
  reason: nullable(z.enum(["not_allow_listed", "provider_error"])),
  providerId: nullable(z.string()),
  at: timestamp,
});

/**
 * Body of GET /api/internal/tickets/:id. Strict on purpose: the view is the
 * PII boundary, so it has no key for the raw title, raw description, requester
 * name, requester email or department, and an unknown key is an error.
 * `notifications` lists the reply emails oldest first (P5-T8b); `autofix` stays
 * an empty list until its table exists.
 * `incident` is the helpdesk pair or null (P5-T5b).
 */
export const internalTicketViewSchema = z.strictObject({
  id: z.uuid(),
  // Display only (P5-T1c): the UUID above stays the only key to open or act on a ticket.
  number: ticketNumberSchema,
  status: z.enum(TICKET_STATUSES),
  isTest: z.boolean(),
  source: z.enum(["web", "email"]),
  createdAt: timestamp,
  redacted: nullable(z.strictObject({ title: z.string(), description: z.string() })),
  triage: nullable(
    z.strictObject({
      sensitive: z.boolean(),
      sensitiveFlags: z.array(z.string()),
      category: nullable(z.enum(CATEGORIES)),
      subcategory: nullable(z.string()),
      priority: nullable(z.enum(PRIORITIES)),
      urgency: nullable(z.enum(URGENCIES)),
      assignmentGroup: nullable(z.enum(ASSIGNMENT_GROUPS)),
      route: nullable(z.enum(ROUTES)),
      flags: z.array(z.string()),
      probabilities: nullable(z.record(z.string(), z.number())),
      groundingScore: nullable(z.number()),
      kbArticleIds: z.array(z.uuid()),
      suggestedFix: nullable(z.record(z.string(), z.json())),
      modelVersions: nullable(z.record(z.string(), z.string())),
      triagedAt: nullable(timestamp),
    }),
  ),
  aiCallCount: z.number().int().nonnegative(),
  events: z.array(z.strictObject({ type: z.string(), at: timestamp })),
  reviews: z.array(internalReviewSchema),
  notifications: z.array(internalNotificationSchema),
  autofix: z.array(z.never()),
  // P5-T5b: the helpdesk incident, or null. Both fields or neither: the
  // database holds them as a pair, and a stray key here is an error.
  incident: nullable(z.strictObject({ number: z.string().min(1), sysId: z.string().min(1) })),
});

export type InternalTicketView = z.infer<typeof internalTicketViewSchema>;
