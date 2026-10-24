import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kbArticleSchema, KB_ARTICLE_CONTENT_MAX } from "./kb-article.js";
import { redact } from "./redact.js";
import { CATEGORIES, DEFAULT_GROUP_FOR_CATEGORY, SECURITY_INCIDENT_GROUP } from "./triage.js";

const articles: unknown[] = JSON.parse(
  readFileSync(new URL("../../../supabase/seed/kb-articles.json", import.meta.url), "utf8"),
);
const valid = kbArticleSchema.array().parse(articles);

const base = {
  slug: "reset-your-password",
  title: "How to reset your password",
  content: "1. Open the sign in page. ".repeat(14),
  category: "password_reset",
  assignment_group: "Service Desk",
};

function failedFields(input: unknown): string[] {
  const r = kbArticleSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => String(i.path[0]));
}

describe("kbArticleSchema", () => {
  it("accepts a valid article", () => {
    expect(kbArticleSchema.safeParse(base).success).toBe(true);
  });

  it.each(["has space", "Upper-Case", "double--dash", "-lead", "trail-", ""])(
    "rejects slug %j, naming slug",
    (slug) => {
      expect(failedFields({ ...base, slug })).toContain("slug");
    },
  );

  it("rejects an unknown category, naming category", () => {
    expect(failedFields({ ...base, category: "printing" })).toContain("category");
  });

  it("rejects an unknown assignment group, naming assignment_group", () => {
    expect(failedFields({ ...base, assignment_group: "Nobody" })).toContain("assignment_group");
  });

  it("rejects empty and too long content, naming content", () => {
    expect(failedFields({ ...base, content: "" })).toContain("content");
    expect(failedFields({ ...base, content: "x".repeat(KB_ARTICLE_CONTENT_MAX + 1) })).toContain(
      "content",
    );
  });

  it("rejects a short or long title, naming title", () => {
    expect(failedFields({ ...base, title: "Four" })).toContain("title");
    expect(failedFields({ ...base, title: "t".repeat(121) })).toContain("title");
  });

  it("rejects unknown keys", () => {
    expect(kbArticleSchema.safeParse({ ...base, id: "x" }).success).toBe(false);
  });
});

describe("supabase/seed/kb-articles.json", () => {
  it("holds 30 articles, 5 per category", () => {
    expect(articles).toHaveLength(30);
    for (const category of CATEGORIES) {
      expect(valid.filter((a) => a.category === category)).toHaveLength(5);
    }
  });

  it("has unique slugs", () => {
    expect(new Set(valid.map((a) => a.slug)).size).toBe(valid.length);
  });

  it("uses the default group, except security incidents", () => {
    const security = valid.filter((a) => a.assignment_group === SECURITY_INCIDENT_GROUP);
    expect(security.length).toBeGreaterThanOrEqual(1);
    for (const a of valid) {
      if (a.assignment_group !== SECURITY_INCIDENT_GROUP) {
        expect(a.assignment_group).toBe(DEFAULT_GROUP_FOR_CATEGORY[a.category]);
      }
    }
  });

  it("has numbered steps in every article", () => {
    for (const a of valid) {
      expect(a.content, a.slug).toMatch(/^1\. /m);
      expect(a.content, a.slug).toMatch(/^2\. /m);
    }
  });

  it("holds no PII-shaped text", () => {
    for (const a of valid) {
      expect(redact(a.title).text, a.slug).toBe(a.title);
      expect(redact(a.content).text, a.slug).toBe(a.content);
      expect(`${a.title}\n${a.content}`, a.slug).not.toContain("[REDACTED_");
    }
  });

  it("uses no persona names", () => {
    const names = /\b(alice|bob|carol|dave|erin|frank|gina|abel|tuter)\b/i;
    for (const a of valid) expect(`${a.title}\n${a.content}`, a.slug).not.toMatch(names);
  });

  it("covers the persona problems", () => {
    const all = valid.map((a) => `${a.title} ${a.content}`.toLowerCase()).join("\n");
    for (const word of ["locked", "forgot", "laptop", "monitor", "vpn", "wifi", "phishing", "hr"]) {
      expect(all, word).toContain(word);
    }
  });
});
