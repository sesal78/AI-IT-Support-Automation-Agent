// Signs fake Slack review decisions with the e2e test secret and sends them to
// the e2e app (P4-T6). It never signs for staging: a staging host is refused
// before any request, and loadLiveConfig refuses a process that holds the real
// SLACK_SIGNING_SECRET.
import { randomBytes } from "node:crypto";
import { signSlackRequest, slackUserId } from "@ai-it-support/shared";
import { z } from "zod";
import { createInternalClient, type InternalClient } from "./client.ts";
import { isStagingHost, LiveConfigError, type LiveConfig } from "./config.ts";

export const INTERACTIVITY_PATH = "/api/slack/interactivity";
/** A fixed, non-working response URL: the e2e app must never need a real one. */
export const TEST_RESPONSE_URL = "https://hooks.slack.com/actions/T0000000000/0/test";
const TS = /^[0-9]{1,12}\.[0-9]{1,6}$/;

/** Thrown for a refused input or target. Names the field or rule, never a value. */
export class SlackSignerError extends Error {
  override readonly name = "SlackSignerError";
}

export type Decision = "approve" | "reject";

export interface DecisionInput {
  readonly reviewId: string;
  readonly slackTs: string;
  readonly decision: Decision;
  /** Default: E2E_SLACK_REVIEWER_ID. */
  readonly userId?: string;
  /** Added to the current time, in seconds (for example -301 for a stale request). */
  readonly timestampOffsetSeconds?: number;
  /** Signs with this secret instead of the test secret. */
  readonly secretOverride?: string;
  /** Changes one body byte after signing. */
  readonly tamper?: boolean;
}

export interface SignedRequest {
  readonly body: string;
  readonly headers: {
    readonly "X-Slack-Request-Timestamp": string;
    readonly "X-Slack-Signature": string;
  };
}

export type InteractivityOutcome = "recorded" | "already_decided" | "late";

export interface SendResult {
  readonly status: number;
  /** The `outcome` of a 200 answer, else null. */
  readonly outcome: InteractivityOutcome | null;
  /** The `error` code of any other answer, else null. */
  readonly error: string | null;
}

export interface SlackSigner {
  signedDecision(input: DecisionInput): SignedRequest;
  send(signed: SignedRequest): Promise<SendResult>;
}

const answerSchema = z.union([
  z.object({ outcome: z.enum(["recorded", "already_decided", "late"]) }),
  z.object({ error: z.string().regex(/^[a-z_]{1,32}$/) }),
]);

/** Random letters and digits, for `secretOverride` in tests. */
export function randomSecret(): string {
  return randomBytes(24).toString("hex");
}

/**
 * Needs E2E_SLACK_SIGNING_SECRET, E2E_SLACK_REVIEWER_ID and
 * E2E_SLACK_CHANNEL_ID (a scenario checks them first and reports not_run).
 */
export function createSlackSigner(
  config: LiveConfig,
  options: { readonly client?: InternalClient; readonly now?: () => number } = {},
): SlackSigner {
  const { signingSecret, reviewerId, channelId } = config.slack;
  if (signingSecret === undefined || reviewerId === undefined || channelId === undefined) {
    throw new LiveConfigError(
      "E2E_SLACK_SIGNING_SECRET, E2E_SLACK_REVIEWER_ID and E2E_SLACK_CHANNEL_ID are required",
    );
  }
  const client = options.client ?? createInternalClient(config);
  const now = options.now ?? Date.now;

  function signedDecision(input: DecisionInput): SignedRequest {
    if (!z.uuid().safeParse(input.reviewId).success)
      throw new SlackSignerError("reviewId: must be a UUID");
    if (typeof input.slackTs !== "string" || !TS.test(input.slackTs)) {
      throw new SlackSignerError("slackTs: must be a Slack message ts");
    }
    if (input.decision !== "approve" && input.decision !== "reject") {
      throw new SlackSignerError("decision: must be approve or reject");
    }
    const userId = input.userId ?? reviewerId!;
    if (!slackUserId().safeParse(userId).success)
      throw new SlackSignerError("userId: must be a Slack user ID");
    const offset = input.timestampOffsetSeconds ?? 0;
    if (!Number.isSafeInteger(offset))
      throw new SlackSignerError("timestampOffsetSeconds: must be an integer");
    const secret = input.secretOverride ?? signingSecret!;
    if (typeof secret !== "string" || secret === "") {
      throw new SlackSignerError("secretOverride: must be a non-empty string");
    }

    const timestamp = String(Math.floor(now() / 1000) + offset);
    const payload = {
      type: "block_actions",
      user: { id: userId },
      channel: { id: channelId },
      container: { type: "message", message_ts: input.slackTs, channel_id: channelId },
      actions: [
        {
          type: "button",
          action_id: input.decision === "approve" ? "review_approve" : "review_reject",
          value: input.reviewId,
          action_ts: `${timestamp}.000000`,
        },
      ],
      response_url: TEST_RESPONSE_URL,
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const signature = signSlackRequest({ secret, timestamp, body });
    const sent =
      input.tamper === true ? `${body.slice(0, -1)}${body.endsWith("0") ? "1" : "0"}` : body;
    return {
      body: sent,
      headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature },
    };
  }

  async function send(signed: SignedRequest): Promise<SendResult> {
    if (isStagingHost(new URL(config.origin).hostname, config.stagingOrigin)) {
      throw new SlackSignerError("E2E_BASE_URL: decisions are never signed for staging");
    }
    // Access headers only: the interactivity route takes no internal token.
    const response = await client.send(`POST ${INTERACTIVITY_PATH}`, INTERACTIVITY_PATH, {
      method: "POST",
      token: null,
      rawBody: { text: signed.body, contentType: "application/x-www-form-urlencoded" },
      headers: { ...signed.headers },
    });
    let parsed: z.infer<typeof answerSchema> | undefined;
    try {
      const result = answerSchema.safeParse(JSON.parse(response.text));
      parsed = result.success ? result.data : undefined;
    } catch {
      parsed = undefined;
    }
    return {
      status: response.status,
      outcome: response.status === 200 && parsed && "outcome" in parsed ? parsed.outcome : null,
      error: parsed && "error" in parsed ? parsed.error : null,
    };
  }

  return { signedDecision, send };
}
