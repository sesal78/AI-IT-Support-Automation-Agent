/**
 * A full live env whose every secret is a unique marker, built with
 * `repeat` so no literal secret sits in the source. The token is letters only
 * (the internal token rule); the others carry regex-special characters.
 */
import { SN_PASSWORD, SN_URL, SN_USER } from "./mock-servicenow.ts";
import { RESEND_READ_KEY, TEST_REPLY_RECIPIENT } from "./mock-resend.ts";

export function markerEnv(origin: string) {
  return {
    E2E_BASE_URL: origin,
    INTERNAL_API_TOKEN: `MarkerToken${"x".repeat(40)}`,
    CF_ACCESS_CLIENT_ID: `MarkerAccessId.*+?^$${"y".repeat(20)}`,
    CF_ACCESS_CLIENT_SECRET: `MarkerAccessSecret(|)[]{}\\${"z".repeat(30)}`,
    LANGFUSE_PUBLIC_KEY: `MarkerLangfusePublic${"p".repeat(20)}`,
    LANGFUSE_SECRET_KEY: `MarkerLangfuseSecret${"s".repeat(20)}`,
    LANGFUSE_BASE_URL: `https://markerlangfuse${"l".repeat(10)}.example`,
    STAGING_BASE_URL: `https://markerstaging${"q".repeat(10)}.example`,
    E2E_RESEND_READ_KEY: RESEND_READ_KEY,
    E2E_REPLY_RECIPIENT: TEST_REPLY_RECIPIENT,
  };
}

/** Fake e2e channel, bot user and reviewer IDs (never real ones). */
export const TEST_SLACK = {
  channelId: "C0E2E00001",
  botUserId: "U0BOTUSER1",
  reviewerId: "U0REVIEWER1",
} as const;

/**
 * The four live Slack variables. The token and the signing secret are unique
 * markers built from pieces, so no token-shaped literal sits in the source.
 */
export function markerSlackEnv() {
  return {
    E2E_SLACK_BOT_TOKEN: ["xoxb", `MarkerSlackToken${"t".repeat(20)}`].join("-"),
    E2E_SLACK_CHANNEL_ID: TEST_SLACK.channelId,
    E2E_SLACK_SIGNING_SECRET: `MarkerSigningSecret${"k".repeat(20)}`,
    E2E_SLACK_REVIEWER_ID: TEST_SLACK.reviewerId,
  };
}

/**
 * The three live ServiceNow variables (P5-T7), pointing at the fetch-level
 * mock. The instance URL is the fixed e2e one the helper requires.
 */
export function markerServiceNowEnv() {
  return {
    E2E_SERVICENOW_INSTANCE_URL: SN_URL,
    E2E_SERVICENOW_USERNAME: SN_USER,
    E2E_SERVICENOW_PASSWORD: SN_PASSWORD,
  };
}
