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
    helpdeskReachable: z.boolean(),
    helpdeskAsleep: z.boolean(),
  }),
});

export type HealthConfig = z.infer<typeof healthConfigSchema>;

/**
 * Trigger.dev id of the scheduled helpdesk health task (services/pipeline,
 * P5-T6). The web app reads the output of its latest completed run.
 */
export const HELPDESK_HEALTH_TASK_ID = "helpdesk-health";

/**
 * Output of one `helpdesk-health` run: the chosen connector, its answer and
 * when it was asked. `unknown` means `HELPDESK` itself is missing or invalid.
 * Fixed values only, never an error text or a host.
 */
export const helpdeskHealthOutputSchema = z.strictObject({
  connector: z.enum(["servicenow", "builtin", "unknown"]),
  status: z.enum(["ok", "asleep", "down"]),
  checkedAt: z.iso.datetime(),
});

export type HelpdeskHealthOutput = z.infer<typeof helpdeskHealthOutputSchema>;
