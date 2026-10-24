import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDbClient, createRepositories, DbError, type Repositories } from "@ai-it-support/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientFor } from "../../../packages/db/integration/pg-container.js";
import {
  removeRestStack,
  startRestStack,
  type RestStack,
} from "../../../packages/db/integration/rest-stack.js";
import { kbIngestPayload, runKbIngest, type KbIngestDeps } from "../src/trigger/kb-ingest.js";

// Runs under the egress recorder (setup file). Supabase traffic goes to
// 127.0.0.1 and is not recorded; anything else would fail as un-mocked.
// T3.I.12 lives here, not in packages/db, because runKbIngest is pipeline code
// and db cannot import the pipeline.

const seedPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/seed/kb-articles.json",
);
const seed: unknown = JSON.parse(readFileSync(seedPath, "utf8"));
const seedArticles = () => kbIngestPayload.parse({ articles: seed }).articles;

let stack: RestStack | undefined;
let db: ReturnType<typeof clientFor> | undefined;
let deps: KbIngestDeps & { repos: Repositories };
const logs: unknown[] = [];

function sql(): ReturnType<typeof clientFor> {
  if (!db) throw new Error("database client not connected");
  return db;
}

function depsFor(key: string): KbIngestDeps & { repos: Repositories } {
  if (!stack) throw new Error("stack not started");
  const log = (message: string, data?: Record<string, unknown>) => {
    logs.push([message, data]);
  };
  return {
    repos: createRepositories(
      createDbClient({
        SUPABASE_URL: stack.url,
        SUPABASE_SERVICE_ROLE_KEY: key,
        SUPABASE_DB_SCHEMA: "itsupport",
      }),
    ),
    logger: { info: log, warn: log, error: log },
  };
}

const count = async (): Promise<number> =>
  Number((await sql().query("select count(*) as n from itsupport.kb_articles")).rows[0].n);

const idsBySlug = async (): Promise<Map<string, string>> =>
  new Map((await deps.repos.listKbArticles()).map((row) => [row.slug, row.id]));

beforeAll(async () => {
  stack = await startRestStack();
  db = clientFor(stack.pg);
  await db.connect();
  deps = depsFor(stack.serviceRoleKey);
}, 300_000);

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await removeRestStack(stack);
});

describe("kb-ingest on the local REST stack (T3.I.12)", () => {
  let idsAfterFirst: Map<string, string>;

  it("loads the 30 seed articles, then is idempotent and keeps every id", async () => {
    const articles = seedArticles();
    expect(articles).toHaveLength(30);

    expect(await runKbIngest({ articles }, deps)).toEqual({ upserted: 30, unchanged: 0 });
    expect(await count()).toBe(30);
    idsAfterFirst = await idsBySlug();

    expect(await runKbIngest({ articles }, deps)).toEqual({ upserted: 0, unchanged: 30 });
    expect(await count()).toBe(30);
    expect(await idsBySlug()).toEqual(idsAfterFirst);
  });

  it("writes only a changed article, keeps its id, and kb_search finds the new title", async () => {
    const articles = seedArticles().map((a) => ({ ...a }));
    const first = articles[0];
    if (!first) throw new Error("seed is empty");
    first.title = "Zebrafish quarantine procedure";

    expect(await runKbIngest({ articles }, deps)).toEqual({ upserted: 1, unchanged: 29 });
    expect(await count()).toBe(30);
    expect((await idsBySlug()).get(first.slug)).toBe(idsAfterFirst.get(first.slug));

    const hits = await deps.repos.searchKb("zebrafish", 5);
    expect(hits.map((hit) => hit.slug)).toEqual([first.slug]);
  });

  it("never deletes: a smaller payload leaves the other rows", async () => {
    await runKbIngest({ articles: seedArticles().slice(1, 3) }, deps);
    expect(await count()).toBe(30);
  });

  it("gives a consistent result for two concurrent runs on new slugs", async () => {
    const articles = seedArticles()
      .slice(0, 2)
      .map((a, i) => ({ ...a, slug: `concurrent-${i}` }));
    const results = await Promise.all([
      runKbIngest({ articles }, deps),
      runKbIngest({ articles }, deps),
    ]);
    // Both may see an empty table; either way each row exists once.
    for (const result of results) expect(result.upserted + result.unchanged).toBe(2);
    expect(await count()).toBe(32);
    expect(await runKbIngest({ articles }, deps)).toEqual({ upserted: 0, unchanged: 2 });
  });

  it("rejects invalid payloads at the schema and leaves the row count alone", async () => {
    const before = await count();
    const first = seedArticles()[0];
    if (!first) throw new Error("seed is empty");
    const noContent: Record<string, unknown> = { ...first };
    delete noContent.content;
    expect(kbIngestPayload.safeParse({ articles: [] }).success).toBe(false);
    expect(kbIngestPayload.safeParse({ articles: [noContent] }).success).toBe(false);
    expect(kbIngestPayload.safeParse({ articles: [first, first] }).success).toBe(false);
    expect(
      kbIngestPayload.safeParse({ articles: [{ ...first, category: "printers" }] }).success,
    ).toBe(false);
    expect(await count()).toBe(before);
  });

  it("throws DbError on a read error (bad key)", async () => {
    await expect(runKbIngest({ articles: seedArticles() }, depsFor("not-a-jwt"))).rejects.toThrow(
      DbError,
    );
  });

  it("throws DbError on a write error and writes none of the batch", async () => {
    const before = await count();
    await sql().query(
      "alter table itsupport.kb_articles add constraint tmp_no_forced_fail check (title <> 'Forced failure title')",
    );
    try {
      const articles = seedArticles()
        .slice(0, 3)
        .map((a, i) => ({
          ...a,
          slug: `batch-${i}`,
          title: i === 2 ? "Forced failure title" : a.title,
        }));
      await expect(runKbIngest({ articles }, deps)).rejects.toThrow(DbError);
      expect(await count()).toBe(before);
    } finally {
      await sql().query("alter table itsupport.kb_articles drop constraint tmp_no_forced_fail");
    }
  });

  it("logs counts and slugs only", () => {
    const text = JSON.stringify(logs);
    expect(text).toContain("kb-ingest: done");
    expect(text).not.toContain("Zebrafish");
    expect(text).not.toContain(seedArticles()[1]?.title ?? "missing");
  });
});
