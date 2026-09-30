import { intakeEnvShape, parseEnv } from "@ai-it-support/shared";

const siteKeyShape = { TURNSTILE_SITE_KEY: intakeEnvShape.TURNSTILE_SITE_KEY };

/**
 * The public Turnstile site key, validated with the shared env schema when it
 * is called (at request time), so Dokploy can set it at run time without a
 * build-time NEXT_PUBLIC_ value. The whole env is also validated at boot by
 * instrumentation.ts; this reads only the one key so the page does not need
 * the server secrets in scope.
 */
export function turnstileSiteKey(source: Record<string, string | undefined> = process.env): string {
  return parseEnv(siteKeyShape, source).TURNSTILE_SITE_KEY;
}
