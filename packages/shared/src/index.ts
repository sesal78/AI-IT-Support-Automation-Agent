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
  aiBudgetEnvShape,
  E2E_SERVICENOW_INSTANCE_URL,
  e2eEnvShape,
  formatEnvIssues,
  groundingEnvShape,
  helpdeskEnvShape,
  intakeEnvShape,
  langfuseEnvShape,
  internalEnvShape,
  llmEnvShape,
  liveEnvShape,
  liveServiceNowEnvShape,
  liveSlackEnvShape,
  parseEnv,
  parseHelpdeskEnv,
  phase1EnvShape,
  policyEnvShape,
  slackBotToken,
  slackChannelId,
  slackInteractivityEnvShape,
  slackUserId,
  sensitiveCheckEnvShape,
  serviceNowEnvShape,
  slackClientEnvShape,
  replyEnvShape,
  REPLY_ADDRESS_RE,
  reviewEnvShape,
  triggerProjectEnvShape,
  type EnvIssue,
  type HelpdeskEnv,
} from "./env.js";
export {
  EVAL_SENSITIVE_TOPICS,
  EVAL_SETS,
  evalTicketSchema,
  type EvalSensitiveTopic,
  type EvalSet,
  type EvalTicket,
} from "./eval-ticket.js";
export {
  HELPDESK_HEALTH_TASK_ID,
  healthConfigSchema,
  helpdeskHealthOutputSchema,
  type HealthConfig,
  type HelpdeskHealthOutput,
} from "./health.js";
export {
  assertHelpdeskTransition,
  canHelpdeskTransition,
  HELPDESK_STATE_TRANSITIONS,
  HELPDESK_STATES,
  IllegalHelpdeskTransitionError,
  nextHelpdeskStates,
  type HelpdeskState,
} from "./helpdesk-state.js";
export {
  buildKbQuery,
  KB_QUERY_MAX_WORD_LENGTH,
  KB_QUERY_MAX_WORDS,
  KB_QUERY_MIN_WORD_LENGTH,
} from "./kb-query.js";

export {
  internalReviewSchema,
  internalTicketViewSchema,
  type InternalTicketView,
} from "./internal-ticket.js";
export {
  internalSecurityEventsSchema,
  internalUsageSchema,
  type AiUsage,
  type InternalSecurityEvents,
  type InternalUsage,
} from "./internal-usage.js";
export {
  decideRoute,
  PolicyInputError,
  type PolicyDecision,
  type PolicyInput,
  type PolicyThresholds,
} from "./policy.js";
export { redact, type RedactionResult, type RedactionType } from "./redact.js";
export {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  TICKET_STATUSES,
  type TicketStatus,
} from "./status.js";
export {
  effectiveTestOverrides,
  TestOverridesError,
  testOverridesSchema,
  type TestOverrides,
} from "./test-overrides.js";
export {
  HELPDESK_SYNC_TASK_ID,
  INTAKE_TICKET_TASK_ID,
  NOTIFICATION_KINDS,
  REVIEW_TICKET_TASK_ID,
  TRIAGE_TICKET_TASK_ID,
  TICKET_NUMBER_RE,
  ticketNumberSchema,
  ticketSubmissionSchema,
  type HelpdeskSyncPayload,
  type IntakeTicketPayload,
  type NotificationKind,
  type NotifyRequesterPayload,
  type ReviewTicketPayload,
  type TicketSubmission,
  type TriageTicketPayload,
} from "./ticket.js";
export {
  ASSIGNMENT_GROUPS,
  CATEGORIES,
  DEFAULT_GROUP_FOR_CATEGORY,
  MAX_KB_ARTICLES,
  POLICY_REASONS,
  PRIORITIES,
  ROUTES,
  SECURITY_INCIDENT_GROUP,
  TRIAGE_FLAGS,
  triageResultSchema,
  URGENCIES,
  type AssignmentGroup,
  type Category,
  type PolicyReason,
  type Priority,
  type Route,
  type TriageFlag,
  type TriageResult,
  type Urgency,
} from "./triage.js";
export {
  KB_ARTICLE_CONTENT_MAX,
  KB_ARTICLE_CONTENT_MIN,
  KB_INGEST_TASK_ID,
  kbArticleSchema,
  type KbArticle,
} from "./kb-article.js";
export {
  JUDGE_SCORE_LEVELS,
  JUDGE_STATE_MAX_CHARS,
  JUDGE_STATE_MAX_DEPTH,
  JUDGE_TEXT_TASK_ID,
  hasUnredactedText,
  judgeDefinitionSchema,
  judgeFileName,
  judgePayloadOf,
  judgeQuestionSchema,
  judgeTextOutputSchema,
  judgeTextPayloadSchema,
  type JsonState,
  type JsonValue,
  type JudgeDefinition,
  type JudgeQuestion,
  type JudgeTextOutput,
  type JudgeTextPayload,
} from "./judge.js";
export {
  signSlackRequest,
  verifySlackRequest,
  type SlackRequestHeaders,
  type SlackVerifyFailure,
  type SlackVerifyResult,
} from "./slack-signature.js";
