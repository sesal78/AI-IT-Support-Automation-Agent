import { z } from "zod";

// Slack interactivity: the payload of an Approve / Reject click and the rules
// that decide whether it may be recorded (P4-T3b). Pure code: the route, the
// signature check and the database reads live elsewhere (P4-T3a, c, d).

export type InteractionPayloadReason =
  | "content_type"
  | "no_payload"
  | "not_json"
  | "wrong_type"
  | "unknown_action"
  | "bad_review_id"
  | "missing_field"
  | "bad_response_url";

/**
 * A refused payload. The message holds the reason code only, and the error has
 * no cause: the body is attacker-controlled, so no input value reaches a log.
 */
export class InteractionPayloadError extends Error {
  readonly reason: InteractionPayloadReason;

  constructor(reason: InteractionPayloadReason) {
    super(`invalid Slack interaction payload: ${reason}`);
    this.reason = reason;
  }
}
// On the prototype, so `reason` stays the error's only own enumerable field.
InteractionPayloadError.prototype.name = "InteractionPayloadError";

export type Interaction = {
  decision: "approve" | "reject";
  reviewId: string;
  userId: string;
  channelId: string;
  messageTs: string;
  responseUrl: string;
};

export type Refusal = {
  allowed: false;
  status: 403 | 404;
  kind: "not_allow_listed" | "unknown_review" | "binding_mismatch" | "env_mismatch";
};
export type Check = { allowed: true } | Refusal;

// The media type, any case, then nothing or parameters after `;`. No leading
// whitespace: Headers.get() trims the value already.
const FORM_CONTENT_TYPE = /^application\/x-www-form-urlencoded\s*(;|$)/i;

const DECISIONS = { review_approve: "approve", review_reject: "reject" } as const;

// RFC 9562, lower case (as Postgres writes it), version 1-8 and variant 8-b, so
// the nil and max UUIDs are refused.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RESPONSE_URL_PREFIX = "https://hooks.slack.com/";

// One schema per step, so each failure maps to exactly one reason. z.object
// strips every key it does not name, so Slack's other fields never reach the
// result (and are not walked).
const blockActions = z.object({ type: z.literal("block_actions") });
const oneAction = z.object({
  actions: z.array(z.object({ action_id: z.enum(["review_approve", "review_reject"]) })).length(1),
});
const reviewIdValue = z.object({
  actions: z.array(z.object({ value: z.string().regex(UUID) })),
});
const text = z.string().min(1);
const fields = z.object({
  user: z.object({ id: text }),
  channel: z.object({ id: text }),
  container: z.object({ message_ts: text }),
  response_url: z.string(),
});

function read<T>(schema: z.ZodType<T>, value: unknown, reason: InteractionPayloadReason): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new InteractionPayloadError(reason);
  return result.data;
}

/**
 * `https://hooks.slack.com/…` only, and already in the form the URL parser
 * writes: the prefix pins the scheme and the exact host (no user info, port or
 * longer host can follow it), and the round trip refuses whitespace, control
 * characters and anything else the parser would rewrite.
 */
function isSlackResponseUrl(url: string): boolean {
  return url.startsWith(RESPONSE_URL_PREFIX) && new URL(url).href === url;
}

/**
 * Reads a Slack `block_actions` click from the raw request body. Checks run in
 * this order: content type, a single `payload` form field (a duplicate is
 * refused, never picked), JSON, `type`, exactly one known action, its review
 * ID, the user / channel / message fields, the response URL. The body size is
 * capped by the route before this runs (128 KB, P4-T3c).
 */
export function parseInteraction(rawBody: string, contentType: string | null): Interaction {
  if (!FORM_CONTENT_TYPE.test(String(contentType))) {
    throw new InteractionPayloadError("content_type");
  }
  const payloads = new URLSearchParams(rawBody).getAll("payload");
  if (payloads.length !== 1) throw new InteractionPayloadError("no_payload");
  let json: unknown;
  try {
    json = JSON.parse(payloads[0]);
  } catch {
    throw new InteractionPayloadError("not_json");
  }
  read(blockActions, json, "wrong_type");
  const [{ action_id }] = read(oneAction, json, "unknown_action").actions;
  const [{ value }] = read(reviewIdValue, json, "bad_review_id").actions;
  const { user, channel, container, response_url } = read(fields, json, "missing_field");
  if (!isSlackResponseUrl(response_url)) throw new InteractionPayloadError("bad_response_url");
  return {
    decision: DECISIONS[action_id],
    reviewId: value,
    userId: user.id,
    channelId: channel.id,
    messageTs: container.message_ts,
    responseUrl: response_url,
  };
}

const refuse = (status: Refusal["status"], kind: Refusal["kind"]): Refusal => ({
  allowed: false,
  status,
  kind,
});

/**
 * Exact match against the reviewer IDs from the env (P4-T3c). Anything but an
 * array refuses everyone, so a string list can never match on a substring.
 */
export function checkReviewer(interaction: Interaction, reviewerIds: readonly string[]): Check {
  if (Array.isArray(reviewerIds) && reviewerIds.includes(interaction.userId)) {
    return { allowed: true };
  }
  return refuse(403, "not_allow_listed");
}

/**
 * Whether the click belongs to this review and this environment, in order: no
 * review → 404 unknown_review; another channel or message ts (a review whose
 * card ts was never stored never matches, since messageTs is a non-empty
 * string) → 403 binding_mismatch; a ticket whose isTest differs from e2eMode,
 * or no ticket at all → 403 env_mismatch (plan P4-T3).
 */
export function checkReviewBinding(input: {
  interaction: Interaction;
  channelId: string;
  e2eMode: boolean;
  review: { ticketId: string; slackTs: string | null } | null;
  ticket: { isTest: boolean } | null;
}): Check {
  const { interaction, channelId, e2eMode, review, ticket } = input;
  if (review === null) return refuse(404, "unknown_review");
  // A card whose ts was never stored binds to nothing, whatever the click carries.
  if (review.slackTs === null) return refuse(403, "binding_mismatch");
  if (interaction.channelId !== channelId || interaction.messageTs !== review.slackTs) {
    return refuse(403, "binding_mismatch");
  }
  if (ticket?.isTest !== e2eMode) return refuse(403, "env_mismatch");
  return { allowed: true };
}
