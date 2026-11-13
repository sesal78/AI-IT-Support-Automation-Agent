import {
  e2eEnvShape,
  formatEnvIssues,
  helpdeskEnvShape,
  intakeEnvShape,
  internalEnvShape,
  phase1EnvShape,
  slackInteractivityEnvShape,
  staffAuthEnvShape,
} from "@ai-it-support/shared";
import { createEnv } from "@t3-oss/env-nextjs";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// Validated at import time. Skipped only while `next build` collects route
// modules, so a build does not need real values; they are checked at boot.
export const env = createEnv({
  server: {
    ...phase1EnvShape,
    ...intakeEnvShape,
    ...internalEnvShape,
    ...e2eEnvShape,
    ...slackInteractivityEnvShape,
    ...helpdeskEnvShape,
    SUPABASE_ANON_KEY:
      process.env.HELPDESK === "builtin"
        ? staffAuthEnvShape.SUPABASE_ANON_KEY
        : staffAuthEnvShape.SUPABASE_ANON_KEY.optional(),
  },
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
  skipValidation: process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD,
  onValidationError: (issues) => {
    throw new Error(formatEnvIssues(issues));
  },
});

/** Staff clients require this key even when called outside the builtin route gate. */
export function staffAuthKey(): string {
  const key = env.SUPABASE_ANON_KEY;
  if (!key) throw new Error("SUPABASE_ANON_KEY is required for staff authentication");
  return key;
}
