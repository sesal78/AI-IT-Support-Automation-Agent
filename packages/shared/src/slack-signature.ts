// Slack's v0 request signing scheme ("Verifying requests from Slack"). Pure
// code: no I/O and no logging. Errors and results never hold the secret, the
// signature or the body.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type SlackVerifyFailure = "missing_signature" | "stale_timestamp" | "bad_signature";
export type SlackVerifyResult = { ok: true } | { ok: false; reason: SlackVerifyFailure };

/** A fetch `Headers` object, or a plain object such as Node's IncomingHttpHeaders. */
export type SlackRequestHeaders = Headers | Record<string, string | string[] | undefined>;

const SIGNATURE_HEADER = "x-slack-signature";
const TIMESTAMP_HEADER = "x-slack-request-timestamp";
// 1–12 ASCII digits only: no sign, space, exponent, hex or non-ASCII digits.
const TIMESTAMP_PATTERN = /^[0-9]{1,12}$/;
const MAX_AGE_SECONDS = 300;

function assertSecret(secret: unknown): void {
  if (typeof secret !== "string" || secret === "") {
    throw new TypeError("secret must be a non-empty string");
  }
}

function assertBody(body: unknown): void {
  if (typeof body !== "string") throw new TypeError("body must be a string");
}

/** `v0=` plus the lower-case hex HMAC-SHA256 of `v0:<timestamp>:<body>`. */
export function signSlackRequest(input: {
  secret: string;
  timestamp: string;
  body: string;
}): string {
  assertSecret(input.secret);
  assertBody(input.body);
  const digest = createHmac("sha256", input.secret)
    .update(`v0:${input.timestamp}:${input.body}`)
    .digest("hex");
  return `v0=${digest}`;
}

/**
 * The header's value, or undefined when it is absent. Names match in any
 * case. Several values (an array, or the name under more than one case) are
 * joined with ", " as a `Headers` object does, so they never verify: the
 * check fails closed and never picks one of them.
 */
function headerValue(headers: SlackRequestHeaders, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const values: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) values.push(...value.filter((v) => typeof v === "string"));
  }
  return values.length === 0 ? undefined : values.join(", ");
}

// Hashing both sides gives equal-length buffers, so timingSafeEqual never
// short-circuits on length and the compare does not leak the signature length.
function signatureMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Verifies a Slack request against the raw body text, before any parsing.
 * Checks, in order: both headers present (missing_signature), the timestamp is
 * 1–12 decimal digits within 300 seconds of nowSeconds either way
 * (stale_timestamp), and the signature matches (bad_signature).
 */
export function verifySlackRequest(input: {
  secret: string;
  headers: SlackRequestHeaders;
  body: string;
  nowSeconds: number;
}): SlackVerifyResult {
  const { secret, headers, body, nowSeconds } = input;
  assertSecret(secret);
  assertBody(body);
  if (!Number.isSafeInteger(nowSeconds)) throw new TypeError("nowSeconds must be a safe integer");
  if (typeof headers !== "object" || headers === null) {
    throw new TypeError("headers must be an object");
  }

  const signature = headerValue(headers, SIGNATURE_HEADER);
  const timestamp = headerValue(headers, TIMESTAMP_HEADER);
  if (signature === undefined || timestamp === undefined) {
    return { ok: false, reason: "missing_signature" };
  }
  if (
    !TIMESTAMP_PATTERN.test(timestamp) ||
    Math.abs(nowSeconds - Number(timestamp)) > MAX_AGE_SECONDS
  ) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expected = signSlackRequest({ secret, timestamp, body });
  return signatureMatches(signature, expected)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}
