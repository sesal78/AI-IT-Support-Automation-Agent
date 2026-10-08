import { z } from "zod";
import { ASSIGNMENT_GROUPS, CATEGORIES } from "./triage.js";

export const KB_ARTICLE_CONTENT_MIN = 300;
export const KB_ARTICLE_CONTENT_MAX = 3000;

/**
 * One row of `supabase/seed/kb-articles.json` (the `itsupport.kb_articles`
 * columns minus `id` and the generated `search`). The DB has no length limits;
 * the 5-120 title and 300-3000 content bounds are seed-quality rules.
 */
export const kbArticleSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be kebab-case"),
  title: z.string().min(5).max(120),
  content: z.string().min(KB_ARTICLE_CONTENT_MIN).max(KB_ARTICLE_CONTENT_MAX),
  category: z.enum(CATEGORIES),
  assignment_group: z.enum(ASSIGNMENT_GROUPS),
});

export type KbArticle = z.infer<typeof kbArticleSchema>;
