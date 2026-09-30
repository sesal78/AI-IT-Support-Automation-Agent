// Shared zod schemas and category maps land here in later phases.
export const packageName = "@ai-it-support/shared";

export {
  formatEnvIssues,
  intakeEnvShape,
  parseEnv,
  phase1EnvShape,
  sensitiveCheckEnvShape,
  type EnvIssue,
} from "./env.js";
export { redact, type RedactionResult, type RedactionType } from "./redact.js";
export {
  INTAKE_TICKET_TASK_ID,
  ticketSubmissionSchema,
  type IntakeTicketPayload,
  type TicketSubmission,
} from "./ticket.js";
