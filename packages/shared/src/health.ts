import { z } from "zod";

/**
 * Body of the public GET /api/health/config. Strict and boolean-only on
 * purpose: the endpoint needs no token, so it must never carry env values,
 * error text or any other internal detail.
 */
export const healthConfigSchema = z.strictObject({
  version: z.string(),
  features: z.strictObject({
    database: z.boolean(),
    migration0003: z.boolean(),
    migration0005: z.boolean(),
    pipelineTrigger: z.boolean(),
    turnstile: z.boolean(),
    internalApi: z.boolean(),
    e2eMode: z.boolean(),
    slackInteractivity: z.boolean(),
  }),
});

export type HealthConfig = z.infer<typeof healthConfigSchema>;
