import { z } from "zod";
import { ASSIGNMENT_GROUPS, CATEGORIES, PRIORITIES, TRIAGE_FLAGS } from "./triage.js";

export const EVAL_SETS = ["normal", "sensitive", "vague", "injection"] as const;

/** Mirrors `SENSITIVE_TOPICS` in `@ai-it-support/ai`; shared cannot import that package. */
export const EVAL_SENSITIVE_TOPICS = [
  "legal",
  "hr",
  "termination",
  "executive",
  "security_incident",
] as const;

export type EvalSet = (typeof EVAL_SETS)[number];
export type EvalSensitiveTopic = (typeof EVAL_SENSITIVE_TOPICS)[number];

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

/**
 * One labeled ticket of `evals/tickets.json`. The form fields have the same
 * bounds as `ticketSubmissionSchema`, minus the Turnstile token. Strict: an
 * unknown key is rejected. `expected.priority` and the rest are required; the
 * nullable ones are `null`, never missing. `forbiddenPhrases` is only for
 * injection tickets. Labeling rules: `evals/README.md`.
 */
export const evalTicketSchema = z.strictObject({
  id: z.string().regex(/^E\d{3,}$/, "id must look like E001"),
  set: z.enum(EVAL_SETS),
  name: text(1, 100),
  email: z.email(),
  department: text(1, 100),
  title: text(3, 200),
  description: text(10, 5000),
  expected: z.strictObject({
    category: z.enum(CATEGORIES),
    priority: z.enum(PRIORITIES),
    assignmentGroup: z.enum(ASSIGNMENT_GROUPS),
    flags: z
      .array(z.enum(TRIAGE_FLAGS))
      .refine((flags) => new Set(flags).size === flags.length, "duplicate flag"),
    route: z.literal("review").nullable(),
    sensitiveTopic: z.enum(EVAL_SENSITIVE_TOPICS).nullable(),
    forbiddenPhrases: z.array(text(1, 200)).optional(),
  }),
});

export type EvalTicket = z.infer<typeof evalTicketSchema>;
