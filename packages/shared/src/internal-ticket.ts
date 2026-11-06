import { z } from "zod";
import { ASSIGNMENT_GROUPS, CATEGORIES, PRIORITIES, ROUTES, URGENCIES } from "./triage.js";
import { TICKET_STATUSES } from "./status.js";

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
 * Body of GET /api/internal/tickets/:id. Strict on purpose: the view is the
 * PII boundary, so it has no key for the raw title, raw description, requester
 * name, requester email or department, and an unknown key is an error.
 * `notifications` and `autofix` stay empty lists until their tables exist.
 */
export const internalTicketViewSchema = z.strictObject({
  id: z.uuid(),
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
  notifications: z.array(z.never()),
  autofix: z.array(z.never()),
});

export type InternalTicketView = z.infer<typeof internalTicketViewSchema>;
