import {
  createDbClient,
  createRepositories,
  type KbArticleRow,
  type Repositories,
} from "@ai-it-support/db";
import { KB_INGEST_TASK_ID, kbArticleSchema } from "@ai-it-support/shared";
import { logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

export const KB_INGEST_MAX_ARTICLES = 200;

export const kbIngestPayload = z
  .object({ articles: z.array(kbArticleSchema).min(1).max(KB_INGEST_MAX_ARTICLES) })
  .superRefine(({ articles }, ctx) => {
    const seen = new Set<string>();
    articles.forEach((article, index) => {
      if (seen.has(article.slug)) {
        ctx.addIssue({
          code: "custom",
          path: ["articles", index, "slug"],
          message: "slug must be unique within the payload",
        });
      }
      seen.add(article.slug);
    });
  });

export type KbIngestPayload = z.infer<typeof kbIngestPayload>;

export interface KbIngestResult {
  upserted: number;
  unchanged: number;
}

type LogFn = (message: string, data?: Record<string, unknown>) => void;

export interface KbIngestDeps {
  repos: Pick<Repositories, "listKbArticles" | "upsertKbArticles">;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

/** Validates env and builds the real deps. Invalid variables throw, naming the variable. */
export function createKbIngestDeps(source: Record<string, string | undefined>): KbIngestDeps {
  return { repos: createRepositories(createDbClient(source)), logger };
}

const FIELDS = ["title", "content", "category", "assignment_group"] as const;

/**
 * The task body, exported so tests can call it without the Trigger.dev runtime.
 *
 * Upserts by slug and never deletes. An article whose stored title, content,
 * category and assignment group all equal the payload's (exact string
 * comparison, so a whitespace-only edit counts as a change) is not written.
 * The changed articles go out in one upsert request, so the write is atomic;
 * any database error throws a DbError and no result is returned. A retry or a
 * concurrent run is safe: the upsert is keyed on the unique slug and keeps ids.
 *
 * Privacy: logs carry counts and slugs, never titles or content.
 */
export async function runKbIngest(
  payload: KbIngestPayload,
  deps: KbIngestDeps,
): Promise<KbIngestResult> {
  const { repos, logger: log } = deps;
  const bySlug = new Map<string, KbArticleRow>(
    (await repos.listKbArticles()).map((row) => [row.slug, row]),
  );
  const changed = payload.articles.filter((article) => {
    const current = bySlug.get(article.slug);
    return !current || FIELDS.some((field) => current[field] !== article[field]);
  });

  if (changed.length > 0) await repos.upsertKbArticles(changed);

  const result = { upserted: changed.length, unchanged: payload.articles.length - changed.length };
  log.info("kb-ingest: done", { ...result, slugs: changed.map((article) => article.slug) });
  return result;
}

/**
 * Loads knowledge base articles into `kb_articles`. Triggered by the
 * orchestrator by id "kb-ingest" with the content of supabase/seed/kb-articles.json.
 */
export const kbIngest = schemaTask({
  id: KB_INGEST_TASK_ID,
  schema: kbIngestPayload,
  run: async (payload) => runKbIngest(payload, createKbIngestDeps(process.env)),
});
