import { pipelineScenarios } from "./pipeline.ts";
import type { Scenario } from "./runner.ts";
import { securityScenarios } from "./security.ts";

/** The live scenarios by test ID. They land in P3-T16b to P3-T16d. */
export const scenarios: readonly Scenario[] = [...securityScenarios, ...pipelineScenarios];
