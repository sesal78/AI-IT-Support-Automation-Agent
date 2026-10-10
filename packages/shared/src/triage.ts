import { z } from "zod";

/** The 6 dev420188 incident categories; must equal the checks in migration 0003 (a test compares them). */
export const CATEGORIES = [
  "database",
  "inquiry",
  "software",
  "hardware",
  "password_reset",
  "network",
] as const;
export const PRIORITIES = ["P1", "P2", "P3", "P4"] as const;
export const URGENCIES = ["high", "medium", "low"] as const;
export const ROUTES = ["auto", "review"] as const;
export const TRIAGE_FLAGS = [
  "injection_suspected",
  "needs_info",
  "ungrounded_fix",
  "outage_or_duplicate",
] as const;

/** Every reason the policy engine can give for sending a ticket to review (plan §3, P3-T9). */
export const POLICY_REASONS = [
  "sensitive",
  "injection_suspected",
  "needs_info",
  "low_confidence",
  "p1",
  "outage_or_duplicate",
  "ungrounded_fix",
  "cap_reached",
  "llm_unavailable",
] as const;

/** Exact `sys_user_group.name` values read from dev420188 on 2026-10-04. */
export const ASSIGNMENT_GROUPS = [
  "Service Desk",
  "Hardware",
  "Software",
  "Network",
  "Database",
  "IT Securities",
] as const;

export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Urgency = (typeof URGENCIES)[number];
export type Route = (typeof ROUTES)[number];
export type PolicyReason = (typeof POLICY_REASONS)[number];
export type TriageFlag = (typeof TRIAGE_FLAGS)[number];
export type AssignmentGroup = (typeof ASSIGNMENT_GROUPS)[number];

export const DEFAULT_GROUP_FOR_CATEGORY: Readonly<Record<Category, AssignmentGroup>> = {
  database: "Database",
  hardware: "Hardware",
  software: "Software",
  network: "Network",
  password_reset: "Service Desk",
  inquiry: "Service Desk",
};

/** A security incident goes here, whatever its category. */
export const SECURITY_INCIDENT_GROUP: AssignmentGroup = "IT Securities";

export const MAX_KB_ARTICLES = 3;

// z.number() already rejects NaN and Infinity.
const unitInterval = z.number().min(0).max(1);

/**
 * The columns `triage-ticket` writes to `itsupport.triage_results` (migration 0003).
 * Strict: unknown keys are rejected, not stripped. Every key is required; a
 * column the DB allows to be null is `.nullable()` here, never optional.
 * `triaged_at` is set by the repository, and `sensitive`, `sensitive_flags` and
 * `checker` belong to the sensitive check, so none of them is in this schema.
 * `suggestedFix`'s inner shape is any JSON object until the drafter task fixes it.
 * Duplicate flags and duplicate KB IDs (compared in lower case) are rejected.
 * The four judged fields are null only when the TypeSafe cap stopped the
 * judgments (P3-T10c); a result with any of them null must take the route
 * `review` (the DB columns are nullable, migration 0003).
 */
export const triageResultSchema = z
  .strictObject({
    category: z.enum(CATEGORIES).nullable(),
    subcategory: z.string().trim().min(1).max(100).nullable(),
    priority: z.enum(PRIORITIES).nullable(),
    urgency: z.enum(URGENCIES).nullable(),
    assignmentGroup: z.enum(ASSIGNMENT_GROUPS).nullable(),
    route: z.enum(ROUTES),
    probabilities: z.record(z.string(), unitInterval),
    flags: z
      .array(z.enum(TRIAGE_FLAGS))
      .refine((flags) => new Set(flags).size === flags.length, "duplicate flag"),
    groundingScore: unitInterval.nullable(),
    kbArticleIds: z
      .array(z.uuid().transform((id) => id.toLowerCase()))
      .max(MAX_KB_ARTICLES)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate KB article id"),
    suggestedFix: z.record(z.string(), z.json()).nullable(),
    modelVersions: z.record(z.string(), z.string()),
  })
  .refine(
    (r) =>
      r.route === "review" ||
      (r.category !== null &&
        r.priority !== null &&
        r.urgency !== null &&
        r.assignmentGroup !== null),
    { path: ["route"], message: "a result without judgments must take the route review" },
  );

export type TriageResult = z.infer<typeof triageResultSchema>;
