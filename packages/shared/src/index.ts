// Shared zod schemas and category maps land here in later phases.
export const packageName = "@ai-it-support/shared";

export {
  buildCanaries,
  CANARY_TYPES,
  canaryTicketText,
  findCanaries,
  type Canary,
  type CanaryHit,
  type CanaryType,
} from "./canaries.js";
export {
  e2eEnvShape,
  formatEnvIssues,
  intakeEnvShape,
  internalEnvShape,
  parseEnv,
  phase1EnvShape,
  sensitiveCheckEnvShape,
  triggerProjectEnvShape,
  type EnvIssue,
} from "./env.js";
export { healthConfigSchema, type HealthConfig } from "./health.js";
export {
  buildKbQuery,
  KB_QUERY_MAX_WORD_LENGTH,
  KB_QUERY_MAX_WORDS,
  KB_QUERY_MIN_WORD_LENGTH,
} from "./kb-query.js";
export { redact, type RedactionResult, type RedactionType } from "./redact.js";
export {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  TICKET_STATUSES,
  type TicketStatus,
} from "./status.js";
export {
  INTAKE_TICKET_TASK_ID,
  ticketSubmissionSchema,
  type IntakeTicketPayload,
  type TicketSubmission,
} from "./ticket.js";
export {
  ASSIGNMENT_GROUPS,
  CATEGORIES,
  DEFAULT_GROUP_FOR_CATEGORY,
  MAX_KB_ARTICLES,
  PRIORITIES,
  ROUTES,
  SECURITY_INCIDENT_GROUP,
  TRIAGE_FLAGS,
  triageResultSchema,
  URGENCIES,
  type AssignmentGroup,
  type Category,
  type Priority,
  type Route,
  type TriageFlag,
  type TriageResult,
  type Urgency,
} from "./triage.js";
