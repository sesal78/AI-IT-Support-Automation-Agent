import { browserFormScenario } from "./browser-form.ts";
import { observabilityScenarios } from "./observability.ts";
import { pipelineScenarios } from "./pipeline.ts";
import type { Scenario } from "./runner.ts";
import { securityScenarios } from "./security.ts";
import { slackScenarios } from "./slack-scenarios.ts";

/** The live scenarios by test ID (P3-T16b to P3-T16d, P4-T8a). */
export const scenarios: readonly Scenario[] = [
  ...securityScenarios,
  ...pipelineScenarios,
  browserFormScenario,
  ...observabilityScenarios,
  ...slackScenarios,
];
