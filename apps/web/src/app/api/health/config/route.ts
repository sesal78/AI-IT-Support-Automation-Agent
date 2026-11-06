import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import { env } from "@/env";
import { createHealthConfigProvider } from "@/lib/health/config";

// Never prerendered: the body reflects the live database and env.
export const dynamic = "force-dynamic";

let repositories: Repositories | undefined;
function repos(): Repositories {
  repositories ??= createRepositories(
    createDbClient({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_DB_SCHEMA: env.SUPABASE_DB_SCHEMA,
    }),
  );
  return repositories;
}

let provider: ReturnType<typeof createHealthConfigProvider> | undefined;
function health() {
  provider ??= createHealthConfigProvider({
    probe: () => repos().probeSchema(),
    flags: {
      version: env.APP_VERSION,
      pipelineTrigger: Boolean(env.TRIGGER_SECRET_KEY),
      turnstile: Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY),
      internalApi: Boolean(env.INTERNAL_API_TOKEN),
      e2eMode: env.E2E_MODE,
      slackInteractivity: Boolean(
        env.SLACK_SIGNING_SECRET && env.SLACK_REVIEWER_IDS.length > 0 && env.SLACK_CHANNEL_ID,
      ),
    },
  });
  return provider;
}

const HEADERS = { "Cache-Control": "no-store" };

/** Public, no token: the body is a version string and booleans only. */
export async function GET() {
  return Response.json(await health().get(), { headers: HEADERS });
}

const notAllowed = () =>
  new Response(null, { status: 405, headers: { ...HEADERS, Allow: "GET, HEAD, OPTIONS" } });
export function OPTIONS() {
  return new Response(null, { status: 204, headers: { ...HEADERS, Allow: "GET, HEAD, OPTIONS" } });
}
export { notAllowed as DELETE, notAllowed as PATCH, notAllowed as POST, notAllowed as PUT };
