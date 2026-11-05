// Seeds the 30 KB articles of supabase/seed into a local REST stack, as the
// shared database has them. TEST CODE ONLY: never import it from `src`. It does
// not import vitest, so the Playwright stack can load it too.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, createRepositories } from "@ai-it-support/db";
import type { RestStack } from "../../../packages/db/integration/rest-stack.js";
import { kbIngestPayload, runKbIngest } from "../src/trigger/kb-ingest.js";
import { pipelineEnv } from "./provider-mocks.js";

const seedPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/seed/kb-articles.json",
);

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Ingests the seed articles; no external call (search is Postgres full text). */
export async function seedKnowledgeBase(stack: RestStack): Promise<void> {
  const seed: unknown = JSON.parse(readFileSync(seedPath, "utf8"));
  const { articles } = kbIngestPayload.parse({ articles: seed });
  const repos = createRepositories(createDbClient(pipelineEnv(stack)));
  await runKbIngest({ articles }, { repos, logger: quiet });
}
