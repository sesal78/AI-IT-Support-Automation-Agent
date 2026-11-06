import { randomUUID } from "node:crypto";
import { verifySlackRequest } from "@ai-it-support/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createInternalClient } from "./client.ts";
import { loadLiveConfig, LiveConfigError, type LiveConfig } from "./config.ts";
import {
  createSlackSigner,
  randomSecret,
  SlackSignerError,
  TEST_RESPONSE_URL,
} from "./slack-signer.ts";
import { markerEnv, markerSlackEnv, TEST_SLACK } from "./testing/env.ts";
import { startMockE2e, type MockE2e } from "./testing/mock-e2e.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0)) await step();
});

const slackEnv = markerSlackEnv();
const SECRET = slackEnv.E2E_SLACK_SIGNING_SECRET;
const TS = "1700000001.000100";

async function setup(): Promise<{ mock: MockE2e; config: LiveConfig }> {
  const values = markerEnv("http://127.0.0.1:1");
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    slackSigningSecret: SECRET,
  });
  cleanup.push(() => mock.close());
  const config = loadLiveConfig({ ...values, ...slackEnv, E2E_BASE_URL: mock.origin });
  return { mock, config };
}

describe("createSlackSigner", () => {
  it("signs an approve that the shared verifier accepts, and the mock answers 200", async () => {
    const { mock, config } = await setup();
    const signer = createSlackSigner(config);
    const reviewId = randomUUID();
    const signed = signer.signedDecision({ reviewId, slackTs: TS, decision: "approve" });
    expect(
      verifySlackRequest({
        secret: SECRET,
        headers: signed.headers,
        body: signed.body,
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toEqual({ ok: true });
    expect(await signer.send(signed)).toEqual({ status: 200, outcome: "recorded", error: null });

    const [request] = mock.requests;
    expect(request).toMatchObject({
      method: "POST",
      path: "/api/slack/interactivity",
      accessOk: true,
      hasAuthorization: false,
      slack: { ok: true },
    });
    expect(mock.interactions).toEqual([
      {
        type: "block_actions",
        user: { id: TEST_SLACK.reviewerId },
        channel: { id: TEST_SLACK.channelId },
        container: { type: "message", message_ts: TS, channel_id: TEST_SLACK.channelId },
        actions: [
          {
            type: "button",
            action_id: "review_approve",
            value: reviewId,
            action_ts: expect.any(String),
          },
        ],
        response_url: TEST_RESPONSE_URL,
      },
    ]);
  });

  it("builds a reject with the given user, form-encoded", async () => {
    const { config } = await setup();
    const signer = createSlackSigner(config);
    const reviewId = randomUUID();
    const signed = signer.signedDecision({
      reviewId,
      slackTs: TS,
      decision: "reject",
      userId: "U0SOMEONE1",
    });
    expect(signed.body.startsWith("payload=")).toBe(true);
    const payload = JSON.parse(new URLSearchParams(signed.body).get("payload")!);
    expect(payload.actions).toHaveLength(1);
    expect(payload.actions[0]).toMatchObject({ action_id: "review_reject", value: reviewId });
    expect(payload.user).toEqual({ id: "U0SOMEONE1" });
  });

  it.each([
    ["secretOverride", { secretOverride: randomSecret() }, "bad_signature"],
    ["a -301 s offset", { timestampOffsetSeconds: -301 }, "stale_timestamp"],
    ["tamper", { tamper: true }, "bad_signature"],
  ])("gets 401 from the shared verifier for %s", async (_case, extra, reason) => {
    const { mock, config } = await setup();
    const signer = createSlackSigner(config);
    const signed = signer.signedDecision({
      reviewId: randomUUID(),
      slackTs: TS,
      decision: "approve",
      ...extra,
    });
    expect(await signer.send(signed)).toEqual({
      status: 401,
      outcome: null,
      error: "unauthorized",
    });
    // The 401 is the shared verifier's own verdict.
    expect(mock.requests[0]!.slack).toEqual({ ok: false, reason });
    expect(mock.interactions).toEqual([]);
  });

  it("tamper changes exactly one byte of the signed body", async () => {
    const { config } = await setup();
    const signer = createSlackSigner(config, { now: () => 1_800_000_000_000 });
    const input = { reviewId: randomUUID(), slackTs: TS, decision: "approve" as const };
    const clean = signer.signedDecision(input);
    const tampered = signer.signedDecision({ ...input, tamper: true });
    expect(tampered.headers).toEqual(clean.headers);
    expect(tampered.body).toHaveLength(clean.body.length);
    const diff = [...clean.body].filter((c, i) => c !== tampered.body[i]);
    expect(diff).toHaveLength(1);
  });

  it("a +299 s offset still verifies (the window is the verifier's)", async () => {
    const { config } = await setup();
    const signer = createSlackSigner(config);
    const signed = signer.signedDecision({
      reviewId: randomUUID(),
      slackTs: TS,
      decision: "approve",
      timestampOffsetSeconds: -299,
    });
    expect((await signer.send(signed)).status).toBe(200);
  });

  it.each([
    ["reviewId", { reviewId: "not-a-uuid" }],
    ["slackTs", { slackTs: "1700000001" }],
    ["decision", { decision: "maybe" }],
    ["userId", { userId: "u0lower" }],
    ["timestampOffsetSeconds", { timestampOffsetSeconds: 1.5 }],
    ["secretOverride", { secretOverride: "" }],
  ])("refuses a bad %s, naming it", async (field, bad) => {
    const { config } = await setup();
    const signer = createSlackSigner(config);
    const input = { reviewId: randomUUID(), slackTs: TS, decision: "approve", ...bad };
    expect(() => signer.signedDecision(input as never)).toThrow(SlackSignerError);
    expect(() => signer.signedDecision(input as never)).toThrow(field);
  });

  it("needs the signing secret, reviewer and channel", () => {
    const config = loadLiveConfig(markerEnv("https://e2e.example.com"));
    expect(() => createSlackSigner(config)).toThrow(LiveConfigError);
  });
});

describe("createSlackSigner staging refusal", () => {
  it.each([
    ["the exact STAGING_BASE_URL host", "https://qa.example.com", "https://qa.example.com"],
    ["the staging host with a trailing dot", "https://qa.example.com.", "https://qa.example.com"],
    ["the staging host in upper case", "https://QA.example.com", "https://qa.example.com"],
    ["a first label staging", "https://staging.x.example", undefined],
    ["a first label my-staging", "https://my-staging.x.example", undefined],
    ["a first label STAGING", "https://STAGING.x.example", undefined],
    ["a staging first label with a trailing dot", "https://staging.", undefined],
  ])("refuses %s before any request", async (_case, origin, stagingOrigin) => {
    const { mock, config } = await setup();
    // loadLiveConfig already refuses these; the signer checks again on its own.
    const target: LiveConfig = {
      ...config,
      origin: new URL(origin).origin,
      host: new URL(origin).host,
      stagingOrigin,
    };
    const client = createInternalClient(target);
    const signer = createSlackSigner(target, { client });
    const signed = signer.signedDecision({
      reviewId: randomUUID(),
      slackTs: TS,
      decision: "approve",
    });
    await expect(signer.send(signed)).rejects.toThrow(SlackSignerError);
    expect(mock.requests).toHaveLength(0);
  });

  it("loadLiveConfig refuses those hosts too", () => {
    const env = { ...markerEnv("https://qa.example.com"), ...slackEnv };
    for (const [base, staging] of [
      ["https://qa.example.com.", "https://qa.example.com"],
      ["https://my-staging.x.example", undefined],
    ]) {
      expect(() =>
        loadLiveConfig({ ...env, E2E_BASE_URL: base, STAGING_BASE_URL: staging }),
      ).toThrow("live tests never run against staging");
    }
  });
});
