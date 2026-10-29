import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import { wait } from "@trigger.dev/sdk";
import { env } from "@/env";
import { createDecide } from "@/lib/slack/decide";
import { createInteractivityHandler } from "@/lib/slack/handler";

// Never prerendered or cached: every answer depends on the signed request.
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

const recordSecurityEvent = (source: string, kind: string, sample: Record<string, unknown>) =>
  repos().recordSecurityEvent(source, kind, sample);

const handle = createInteractivityHandler({
  signingSecret: env.SLACK_SIGNING_SECRET,
  reviewerIds: env.SLACK_REVIEWER_IDS,
  recordSecurityEvent,
  nowSeconds: () => Math.floor(Date.now() / 1000),
  decide: createDecide({
    repos: {
      getReview: (id) => repos().getReview(id),
      getTicket: (id) => repos().getTicket(id),
      decideReview: (id, decision, userId) => repos().decideReview(id, decision, userId),
    },
    recordSecurityEvent,
    channelId: env.SLACK_CHANNEL_ID,
    e2eMode: env.E2E_MODE,
    completeToken: (tokenId, output) => wait.completeToken(tokenId, output),
    fetch: (input, init) => fetch(input, init),
  }),
});

export function POST(request: Request): Promise<Response> {
  return handle(request);
}

const notAllowed = () =>
  new Response(null, { status: 405, headers: { "Cache-Control": "no-store", Allow: "POST" } });
export {
  notAllowed as DELETE,
  notAllowed as GET,
  notAllowed as HEAD,
  notAllowed as OPTIONS,
  notAllowed as PATCH,
  notAllowed as PUT,
};
