import { browserFormScenario } from "./browser-form.ts";
import { leakScenarios } from "./helpdesk-leak.ts";
import { replyScenarios } from "./helpdesk-reply.ts";
import { helpdeskScenarios, reconciliationScenario } from "./helpdesk-scenarios.ts";
import { observabilityScenarios } from "./observability.ts";
import { pipelineScenarios } from "./pipeline.ts";
import { reviewFlowScenarios } from "./review-flow.ts";
import { reviewHeavyScenarios } from "./review-heavy.ts";
import { reviewSecurityScenarios } from "./review-security.ts";
import type { Scenario } from "./runner.ts";
import { securityScenarios } from "./security.ts";
import { serviceNowContractScenario } from "./servicenow-contract.ts";
import { slackScenarios } from "./slack-scenarios.ts";

/**
 * The live scenarios by test ID (P3-T16b to P3-T16d, P4-T8a to P4-T8d, P5-T3b,
 * P5-T5c, P5-T8c). T5.O.01 reads every ticket a run created, so it stays last.
 */
export const scenarios: readonly Scenario[] = [
  ...securityScenarios,
  ...pipelineScenarios,
  browserFormScenario,
  ...observabilityScenarios,
  ...slackScenarios,
  ...reviewFlowScenarios,
  ...reviewSecurityScenarios,
  ...reviewHeavyScenarios,
  serviceNowContractScenario,
  ...helpdeskScenarios,
  ...replyScenarios,
  ...leakScenarios,
  reconciliationScenario,
];
