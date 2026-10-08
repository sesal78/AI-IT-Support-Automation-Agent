import { z } from "zod";

const usage = z.strictObject({
  calls: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  /** null while the provider has no priced calls (the LLM is on a subscription). */
  costUsd: z.number().nonnegative().nullable(),
});

/** Body of GET /api/internal/usage?month=YYYY-MM. Strict. */
export const internalUsageSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  llm: usage,
  typesafe: usage,
});

/** Body of GET /api/internal/security-events. Strict: no `sample` key, ever. */
export const internalSecurityEventsSchema = z.strictObject({
  events: z.array(
    z.strictObject({
      source: z.string(),
      kind: z.string(),
      windowStart: z.iso.datetime({ offset: true }),
      count: z.number().int().positive(),
    }),
  ),
});

export type AiUsage = z.infer<typeof usage>;
export type InternalUsage = z.infer<typeof internalUsageSchema>;
export type InternalSecurityEvents = z.infer<typeof internalSecurityEventsSchema>;
