import {
  formatEnvIssues,
  intakeEnvShape,
  internalEnvShape,
  phase1EnvShape,
} from "@ai-it-support/shared";
import { createEnv } from "@t3-oss/env-nextjs";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// Validated at import time. Skipped only while `next build` collects route
// modules, so a build does not need real values; they are checked at boot.
export const env = createEnv({
  server: { ...phase1EnvShape, ...intakeEnvShape, ...internalEnvShape },
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
  skipValidation: process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD,
  onValidationError: (issues) => {
    throw new Error(formatEnvIssues(issues));
  },
});
