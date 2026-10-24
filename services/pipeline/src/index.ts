export const packageName = "@ai-it-support/pipeline";

export {
  healthcheck,
  type HealthcheckPayload,
  type HealthcheckResult,
} from "./trigger/healthcheck.js";
export {
  intakeTicket,
  type IntakeTicketPayload,
  type IntakeTicketResult,
} from "./trigger/intake-ticket.js";
export {
  triageTicket,
  type TriageTicketPayload,
  type TriageTicketResult,
} from "./trigger/triage-ticket.js";
export { kbIngest, type KbIngestPayload, type KbIngestResult } from "./trigger/kb-ingest.js";
export { judgeText, type JudgeTextOutput, type JudgeTextPayload } from "./trigger/judge-text.js";
