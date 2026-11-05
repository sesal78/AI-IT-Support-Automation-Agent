import { createAlertSink, errorClassName, type AlertFn } from "@ai-it-support/ai";
import type { Repositories } from "@ai-it-support/db";
import { e2eEnvShape, parseEnv, slackClientEnvShape } from "@ai-it-support/shared";
import { createSlackClient, type SlackClient } from "@ai-it-support/slack";
import { logger as triggerLogger } from "@trigger.dev/sdk";

export interface PipelineAlertOptions {
  /** Replaced in tests. Default: the real Slack Web API client. */
  createClient?: (options: { token: string }) => Pick<SlackClient, "postMessage">;
  logger?: { error(message: string): void };
}

const isSet = (value: string | undefined) => value !== undefined && value !== "";

/**
 * The pipeline's alert sink (resolved point 7). It records the alert and logs
 * it; when SLACK_BOT_TOKEN and SLACK_CHANNEL_ID are both set it also posts the
 * line to SLACK_ALERT_CHANNEL_ID, or to SLACK_CHANNEL_ID when that is unset.
 * Without them nothing is posted. Set but invalid Slack values throw, naming
 * the variable, when the deps are built. The returned function never throws.
 */
export function createPipelineAlert(
  source: Record<string, string | undefined>,
  repos: Pick<Repositories, "recordSecurityEvent">,
  options: PipelineAlertOptions = {},
): AlertFn {
  const { E2E_MODE } = parseEnv(e2eEnvShape, source);
  const log = options.logger ?? { error: (message: string) => triggerLogger.error(message) };
  let postAlert: ((line: string) => Promise<unknown>) | undefined;
  if (isSet(source.SLACK_BOT_TOKEN) && isSet(source.SLACK_CHANNEL_ID)) {
    const env = parseEnv(slackClientEnvShape, source);
    const client = (options.createClient ?? createSlackClient)({ token: env.SLACK_BOT_TOKEN });
    const channel = env.SLACK_ALERT_CHANNEL_ID ?? env.SLACK_CHANNEL_ID;
    postAlert = (line) =>
      client.postMessage({
        channel,
        text: line,
        blocks: [{ type: "section", text: { type: "plain_text", text: line, emoji: false } }],
      });
  }
  return createAlertSink({
    recordSecurityEvent: repos.recordSecurityEvent,
    logger: log,
    postAlert,
    environment: E2E_MODE ? "e2e" : "staging",
  });
}

/**
 * The alert sink for a task's `onFailure` hook. The run may have failed on an
 * invalid Slack or E2E_MODE value, which must not stop the failure from being
 * recorded: then it falls back to a sink without a Slack post and logs the
 * error class name, prefixed with `task`.
 */
export function createFailureAlert(
  task: string,
  source: Record<string, string | undefined>,
  repos: Pick<Repositories, "recordSecurityEvent">,
): AlertFn {
  try {
    return createPipelineAlert(source, repos);
  } catch (error) {
    triggerLogger.error(`${task}: invalid alert env, Slack alert post off`, {
      error: errorClassName(error),
    });
    return createAlertSink({
      recordSecurityEvent: repos.recordSecurityEvent,
      logger: { error: (message) => triggerLogger.error(message) },
    });
  }
}
