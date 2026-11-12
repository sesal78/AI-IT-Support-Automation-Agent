import { z } from "zod";

/**
 * Body of the public GET /api/health/config. Strict and boolean-only on
 * purpose: the endpoint needs no token, so it must never carry env values,
 * error text or any other internal detail.
 */
export const healthConfigSchema = z.strictObject({
  version: z.string(),
  // The configured HELPDESK (P5-T14): one of two fixed words, never an env value.
  helpdesk: z.enum(["servicenow", "builtin"]),
  features: z.strictObject({
    database: z.boolean(),
    migration0003: z.boolean(),
    migration0005: z.boolean(),
    // The notifications table (P5-T8b): a select on notifications.id works.
    migration0006: z.boolean(),
    pipelineTrigger: z.boolean(),
    turnstile: z.boolean(),
    internalApi: z.boolean(),
    e2eMode: z.boolean(),
    slackInteractivity: z.boolean(),
    helpdeskReachable: z.boolean(),
    helpdeskAsleep: z.boolean(),
    // The built-in helpdesk's database objects (0007 and 0008) are present.
    // Checked only when HELPDESK=builtin; false otherwise.
    builtinHelpdesk: z.boolean(),
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
