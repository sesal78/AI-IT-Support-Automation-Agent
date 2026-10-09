import { randomUUID } from "node:crypto";
import { DbError, type KbArticleRow } from "@ai-it-support/db";
import type { KbArticle } from "@ai-it-support/shared";
import { describe, expect, it, vi } from "vitest";
import { createKbIngestDeps, kbIngest, kbIngestPayload, runKbIngest } from "./kb-ingest.js";

const TITLE = "Reset the VPN client";
const CONTENT = "Steps to reset the VPN client. ".repeat(12).trim(); // 359 chars

function article(slug: string, overrides: Partial<KbArticle> = {}): KbArticle {
  return {
    slug,
    title: TITLE,
    content: CONTENT,
    category: "network",
    assignment_group: "Network",
    ...overrides,
  };
}

const stored = (a: KbArticle): KbArticleRow => ({ id: randomUUID(), ...a });

function harness(existing: KbArticleRow[] = []) {
  const logs: Array<[string, unknown]> = [];
  const upserts: KbArticle[][] = [];
  const listKbArticles = vi.fn(async () => existing);
  const upsertKbArticles = vi.fn(async (rows: readonly KbArticle[]) => {
    upserts.push([...rows]);
    return rows.length;
  });
  const log = (message: string, data?: Record<string, unknown>) => {
    logs.push([message, data]);
  };
  const deps = {
    repos: { listKbArticles, upsertKbArticles },
    logger: { info: log, warn: log, error: log },
  };
  return { deps, logs, upserts, listKbArticles, upsertKbArticles };
}

describe("kbIngestPayload", () => {
  const field = (payload: unknown): string[] => {
    const parsed = kbIngestPayload.safeParse(payload);
    if (parsed.success) throw new Error("payload was accepted");
    return parsed.error.issues.map((issue) => issue.path.join("."));
  };

  it("accepts 1 and 200 articles and rejects 0 and 201", () => {
    const many = (n: number) => ({
      articles: Array.from({ length: n }, (_, i) => article(`slug-${i}`)),
    });
    expect(kbIngestPayload.safeParse(many(1)).success).toBe(true);
    expect(kbIngestPayload.safeParse(many(200)).success).toBe(true);
    expect(field(many(0))).toEqual(["articles"]);
    expect(field(many(201))).toEqual(["articles"]);
  });

  it("names the field of an article without content", () => {
    const noContent: Record<string, unknown> = { ...article("a-one") };
    delete noContent.content;
    expect(field({ articles: [noContent] })).toEqual(["articles.0.content"]);
  });

  it("names the field of an unknown category", () => {
    expect(field({ articles: [article("a-one", { category: "printers" as never })] })).toEqual([
      "articles.0.category",
    ]);
  });

  it("rejects a duplicate slug, naming the second article's slug", () => {
    expect(field({ articles: [article("a-one"), article("b-two"), article("a-one")] })).toEqual([
      "articles.2.slug",
    ]);
  });

  it("treats slugs that differ only by case as invalid (the schema forbids upper case)", () => {
    expect(field({ articles: [article("A-one")] })).toEqual(["articles.0.slug"]);
  });
});

describe("runKbIngest", () => {
  it("writes everything on an empty table", async () => {
    const h = harness();
    const articles = [article("a-one"), article("b-two")];
    expect(await runKbIngest({ articles }, h.deps)).toEqual({ upserted: 2, unchanged: 0 });
    expect(h.upserts).toEqual([articles]);
  });

  it("writes nothing when every article matches", async () => {
    const articles = [article("a-one"), article("b-two")];
    const h = harness(articles.map(stored));
    expect(await runKbIngest({ articles }, h.deps)).toEqual({ upserted: 0, unchanged: 2 });
    expect(h.upsertKbArticles).not.toHaveBeenCalled();
  });

  it.each([
    ["title", { title: "A different title" }],
    ["content", { content: `${CONTENT} More.` }],
    ["category", { category: "software" as const }],
    ["assignment group", { assignment_group: "Hardware" as const }],
  ])("sends only the article whose %s changed", async (_name, change) => {
    const a = article("a-one");
    const b = article("b-two");
    const h = harness([stored(a), stored(b)]);
    const changed = article("b-two", change);
    expect(await runKbIngest({ articles: [a, changed] }, h.deps)).toEqual({
      upserted: 1,
      unchanged: 1,
    });
    expect(h.upserts).toEqual([[changed]]);
  });

  it("counts a whitespace-only content change as changed (exact comparison)", async () => {
    const a = article("a-one");
    const h = harness([stored(a)]);
    const edited = article("a-one", { content: `${CONTENT} ` });
    expect(await runKbIngest({ articles: [edited] }, h.deps)).toEqual({
      upserted: 1,
      unchanged: 0,
    });
  });

  it("ignores stored articles that are not in the payload and never deletes", async () => {
    const h = harness([stored(article("old-one")), stored(article("a-one"))]);
    expect(await runKbIngest({ articles: [article("a-one")] }, h.deps)).toEqual({
      upserted: 0,
      unchanged: 1,
    });
  });

  it("throws the DbError from the read and writes nothing", async () => {
    const h = harness();
    h.listKbArticles.mockRejectedValueOnce(new DbError("listKbArticles", "supabase error XX000"));
    await expect(runKbIngest({ articles: [article("a-one")] }, h.deps)).rejects.toBeInstanceOf(
      DbError,
    );
    expect(h.upsertKbArticles).not.toHaveBeenCalled();
  });

  it("throws the DbError from the write, with no success result", async () => {
    const h = harness();
    h.upsertKbArticles.mockRejectedValueOnce(
      new DbError("upsertKbArticles", "supabase error 23514"),
    );
    await expect(runKbIngest({ articles: [article("a-one")] }, h.deps)).rejects.toBeInstanceOf(
      DbError,
    );
  });

  it("logs counts and slugs only, never titles or content", async () => {
    const h = harness([stored(article("b-two"))]);
    await runKbIngest({ articles: [article("a-one"), article("b-two")] }, h.deps);
    expect(h.logs.length).toBeGreaterThan(0);
    const text = JSON.stringify(h.logs);
    expect(text).toContain("a-one");
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain("Steps to reset");
  });
});

describe("createKbIngestDeps", () => {
  it("fails on a missing database variable, naming it", () => {
    expect(() => createKbIngestDeps({})).toThrow(/SUPABASE_URL/);
  });

  it("builds repositories from a valid env", () => {
    const deps = createKbIngestDeps({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      SUPABASE_DB_SCHEMA: "itsupport",
    });
    expect(typeof deps.repos.listKbArticles).toBe("function");
  });
});

describe("kbIngest task", () => {
  it("is registered as kb-ingest", () => {
    expect(kbIngest.id).toBe("kb-ingest");
  });
});
