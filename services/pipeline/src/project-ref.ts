// No imports here: the trigger CLI loads trigger.config.ts, and so this file,
// through jiti, which cannot load @ai-it-support/shared (zod's named `z` export
// comes back undefined). The rule below mirrors triggerProjectEnvShape there.

// Trigger.dev cloud project "AI IT Support Agent" (org Topues), created in
// human step H2 on 2026-09-27. The ref is not a secret.
const MAIN_PROJECT_REF = "proj_sefqgwbhymcyikibqjmo";

const PROJECT_REF_PATTERN = /^proj_[a-z0-9]+$/;

/**
 * The Trigger.dev project that `trigger.config.ts` targets: TRIGGER_PROJECT_REF
 * when set, else the main project. Empty counts as unset. An invalid value
 * throws an Error that names the variable but never echoes its value.
 */
export function resolveProjectRef(source: Record<string, string | undefined>): string {
  const ref = source.TRIGGER_PROJECT_REF;
  if (ref === undefined || ref === "") return MAIN_PROJECT_REF;
  if (!PROJECT_REF_PATTERN.test(ref)) {
    throw new Error(
      "Invalid environment variables:\n  TRIGGER_PROJECT_REF: must be proj_ followed by lower-case letters and digits",
    );
  }
  return ref;
}
