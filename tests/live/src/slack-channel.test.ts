import { describe, expect, it } from "vitest";
import { loadLiveConfig, LiveConfigError } from "./config.ts";
import {
  createE2eSlackChannel,
  MAX_PAGES,
  SlackChannelApiError,
  SlackChannelGuardError,
  type E2eSlackChannel,
} from "./slack-channel.ts";
import { markerEnv, markerSlackEnv, TEST_SLACK } from "./testing/env.ts";
import {
  createMockSlack,
  type MockSlackMessage,
  type MockSlackOptions,
} from "./testing/mock-slack.ts";

const slackEnv = markerSlackEnv();
const config = loadLiveConfig({ ...markerEnv("https://e2e.example.com"), ...slackEnv });
const TOKEN = slackEnv.E2E_SLACK_BOT_TOKEN;
const CHANNEL = TEST_SLACK.channelId;
const OTHER = "C0000000001";

function setup(options: Partial<MockSlackOptions> = {}) {
  const mock = createMockSlack({
    token: TOKEN,
    botUserId: TEST_SLACK.botUserId,
    channel: { id: CHANNEL, name: "itsupport-e2e", is_general: false },
    ...options,
  });
  return { mock, slack: createE2eSlackChannel(config, mock.fetch) };
}

/** Every method, called on `channel`. */
const calls = (slack: E2eSlackChannel, channel: string) => [
  () => slack.history(channel, { oldest: "0" }),
  () => slack.replies(channel, "1700000000.000001"),
  () => slack.post(channel, "hello"),
  () => slack.delete(channel, "1700000000.000001"),
];

async function guardError(promise: Promise<unknown>): Promise<SlackChannelGuardError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SlackChannelGuardError);
  return error as SlackChannelGuardError;
}

const msg = (ts: string, extra: Partial<MockSlackMessage> = {}): MockSlackMessage => ({
  ts,
  user: TEST_SLACK.botUserId,
  text: `m ${ts}`,
  ...extra,
});

describe("createE2eSlackChannel guard", () => {
  it("runs auth.test then conversations.info before anything else, once", async () => {
    const { mock, slack } = setup();
    await slack.history(CHANNEL);
    await slack.history(CHANNEL);
    expect(mock.methods()).toEqual([
      "auth.test",
      "conversations.info",
      "conversations.history",
      "conversations.history",
    ]);
    expect(await slack.verify()).toEqual({ channelId: CHANNEL, botUserId: TEST_SLACK.botUserId });
  });

  it.each([
    ["general", { name: "general", is_general: false }],
    ["is_general: true", { name: "itsupport-e2e", is_general: true }],
    ["missing is_general", { name: "itsupport-e2e", is_general: undefined }],
    ["the staging channel name", { name: "ai-it-support-automation-agent", is_general: false }],
    ["a trailing space", { name: "itsupport-e2e ", is_general: false }],
    ["upper case", { name: "ITSUPPORT-E2E", is_general: false }],
    ["a suffix", { name: "itsupport-e2e-old", is_general: false }],
  ])("refuses every method for %s, and calls no other Slack method", async (_case, channel) => {
    const { mock, slack } = setup({ channel: { id: CHANNEL, ...channel } });
    for (const call of calls(slack, CHANNEL)) await guardError(call());
    await guardError(slack.verify());
    // The guard ran once and is never retried into an unsafe state.
    expect(mock.methods()).toEqual(["auth.test", "conversations.info"]);
  });

  it("refuses when conversations.info answers for another channel ID", async () => {
    const { mock, slack } = setup({
      override: (r) =>
        r.method === "conversations.info"
          ? { ok: true, channel: { id: OTHER, name: "itsupport-e2e", is_general: false } }
          : undefined,
    });
    expect((await guardError(slack.post(CHANNEL, "x"))).reason).toBe("wrong_channel");
    expect(mock.methods()).toEqual(["auth.test", "conversations.info"]);
  });

  it.each([
    ["auth.test ok: false", "auth.test", { ok: false, error: "invalid_auth" }, ["auth.test"]],
    ["auth.test without a user ID", "auth.test", { ok: true }, ["auth.test"]],
    ["auth.test HTTP 500", "auth.test", new Response("x", { status: 500 }), ["auth.test"]],
    [
      "conversations.info ok: false",
      "conversations.info",
      { ok: false, error: "missing_scope" },
      ["auth.test", "conversations.info"],
    ],
    [
      "conversations.info not JSON",
      "conversations.info",
      new Response("<html>", { status: 200 }),
      ["auth.test", "conversations.info"],
    ],
  ])("refuses everything when %s", async (_case, method, reply, methods) => {
    const { mock, slack } = setup({ override: (r) => (r.method === method ? reply : undefined) });
    for (const call of calls(slack, CHANNEL)) await guardError(call());
    expect(mock.methods()).toEqual(methods);
  });

  it("refuses everything when the guard's request throws, without retrying", async () => {
    let n = 0;
    const slack = createE2eSlackChannel(config, async () => {
      n += 1;
      throw new TypeError(`network down ${TOKEN}`);
    });
    for (const call of calls(slack, CHANNEL)) {
      const error = await guardError(call());
      expect(JSON.stringify(error)).not.toContain(TOKEN);
      expect(String(error.stack)).not.toContain(TOKEN);
    }
    expect(n).toBe(1);
  });

  it("refuses a missing token or channel before any request", () => {
    const bare = loadLiveConfig(markerEnv("https://e2e.example.com"));
    expect(() => createE2eSlackChannel(bare, async () => new Response())).toThrow(LiveConfigError);
  });
});

describe("createE2eSlackChannel channel refusal", () => {
  it.each([OTHER, CHANNEL.toLowerCase(), ` ${CHANNEL}`, `${CHANNEL} `, `${CHANNEL}\n`, ""])(
    "refuses %j in every method before any request",
    async (channel) => {
      const { mock, slack } = setup();
      for (const call of calls(slack, channel)) {
        expect((await guardError(call())).reason).toBe("channel_refused");
      }
      expect(mock.requests).toEqual([]);
      // Also after the guard has passed: still no request for that channel.
      await slack.verify();
      for (const call of calls(slack, channel)) await guardError(call());
      expect(mock.requests.filter((r) => r.params.channel === channel)).toEqual([]);
      expect(mock.methods()).toEqual(["auth.test", "conversations.info"]);
    },
  );

  it("refuses a channel argument that is not a string", async () => {
    const { mock, slack } = setup();
    await guardError(slack.post(undefined as unknown as string, "x"));
    expect(mock.requests).toEqual([]);
  });
});

describe("createE2eSlackChannel history and replies", () => {
  it("follows the cursor across pages and returns ts, user, text, blocks and thread_ts", async () => {
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "card" } }];
    const { mock, slack } = setup({
      pageSize: 2,
      messages: [
        msg("1700000001.000001", { blocks }),
        msg("1700000002.000001", { user: "U0SOMEONE1" }),
        msg("1700000003.000001", { thread_ts: "1700000003.000001" }),
        msg("1700000004.000001"),
        msg("1700000000.000001"),
      ],
    });
    const messages = await slack.history(CHANNEL, { oldest: "1700000000.000001" });
    expect(messages.map((m) => m.ts)).toEqual([
      "1700000004.000001",
      "1700000003.000001",
      "1700000002.000001",
      "1700000001.000001",
    ]);
    expect(messages[3]).toEqual({
      ts: "1700000001.000001",
      user: TEST_SLACK.botUserId,
      bot_id: undefined,
      text: "m 1700000001.000001",
      blocks,
      thread_ts: undefined,
    });
    expect(messages[1]!.thread_ts).toBe("1700000003.000001");
    expect(messages[2]!.user).toBe("U0SOMEONE1");
    const history = mock.requests.filter((r) => r.method === "conversations.history");
    expect(history.map((r) => r.params.cursor)).toEqual([undefined, "2"]);
    expect(history.every((r) => r.params.oldest === "1700000000.000001")).toBe(true);
  });

  it("stops on an empty cursor", async () => {
    const { mock, slack } = setup({ messages: [msg("1700000001.000001")] });
    expect(await slack.history(CHANNEL)).toHaveLength(1);
    expect(mock.methods().filter((m) => m === "conversations.history")).toHaveLength(1);
  });

  it(`throws page_cap after ${MAX_PAGES} pages of a cursor that never ends`, async () => {
    const { mock, slack } = setup({
      override: (r) =>
        r.method === "conversations.history"
          ? { ok: true, messages: [], response_metadata: { next_cursor: "loop" } }
          : undefined,
    });
    const error = await slack.history(CHANNEL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlackChannelApiError);
    expect((error as SlackChannelApiError).code).toBe("page_cap");
    expect(mock.methods().filter((m) => m === "conversations.history")).toHaveLength(MAX_PAGES);
  });

  it("returns a thread, parent first", async () => {
    const parent = "1700000001.000001";
    const { slack } = setup({
      messages: [
        msg(parent, { thread_ts: parent }),
        msg("1700000003.000001", { thread_ts: parent, user: "U0SOMEONE1" }),
        msg("1700000002.000001", { thread_ts: parent }),
        msg("1700000004.000001"),
      ],
    });
    const thread = await slack.replies(CHANNEL, parent);
    expect(thread.map((m) => m.ts)).toEqual([parent, "1700000002.000001", "1700000003.000001"]);
  });

  it("refuses a malformed ts or oldest before the request", async () => {
    const { mock, slack } = setup();
    await expect(slack.replies(CHANNEL, "1&channel=C0000000001")).rejects.toThrow(
      SlackChannelApiError,
    );
    await expect(slack.history(CHANNEL, { oldest: "abc" })).rejects.toThrow(SlackChannelApiError);
    expect(mock.methods()).toEqual(["auth.test", "conversations.info"]);
  });

  it("throws a named error for ok: false, with a safe code only", async () => {
    const { slack } = setup({
      override: (r) =>
        r.method === "conversations.replies" ? { ok: false, error: `bad ${TOKEN}` } : undefined,
    });
    const error = (await slack
      .replies(CHANNEL, "1700000000.000001")
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(SlackChannelApiError);
    expect(error.message).toBe("conversations.replies: not_ok");
  });
});

describe("createE2eSlackChannel post and delete", () => {
  it("posts in the verified channel and deletes its own message", async () => {
    const { mock, slack } = setup();
    const { ts } = await slack.post(CHANNEL, "hello");
    expect(mock.messages.map((m) => m.ts)).toEqual([ts]);
    await slack.delete(CHANNEL, ts);
    expect(mock.messages).toEqual([]);
    expect(mock.methods()).toEqual([
      "auth.test",
      "conversations.info",
      "chat.postMessage",
      "conversations.history",
      "chat.delete",
    ]);
    const check = mock.requests[3]!.params;
    expect(check).toMatchObject({ oldest: ts, latest: ts, inclusive: "true", channel: CHANNEL });
  });

  it.each([
    ["another user's message", msg("1700000001.000001", { user: "U0SOMEONE1" })],
    ["a bot_id-only message with no user", { ts: "1700000001.000001", bot_id: "B0", text: "x" }],
    ["a message that does not exist", msg("1700000009.000001")],
  ])("refuses to delete %s before the delete request", async (_case, message) => {
    const { mock, slack } = setup({ messages: [message] });
    expect((await guardError(slack.delete(CHANNEL, "1700000001.000001"))).reason).toBe(
      "not_bot_message",
    );
    expect(mock.methods()).not.toContain("chat.delete");
    expect(mock.messages).toHaveLength(1);
  });

  it("refuses to delete a thread reply (only top-level messages are checked)", async () => {
    const parent = "1700000001.000001";
    const reply = "1700000002.000001";
    const { mock, slack } = setup({
      messages: [msg(parent, { thread_ts: parent }), msg(reply, { thread_ts: parent })],
    });
    await guardError(slack.delete(CHANNEL, reply));
    expect(mock.methods()).not.toContain("chat.delete");
  });

  it("refuses empty or oversized text before the request", async () => {
    const { mock, slack } = setup();
    await expect(slack.post(CHANNEL, "")).rejects.toThrow(SlackChannelApiError);
    await expect(slack.post(CHANNEL, "x".repeat(4001))).rejects.toThrow(SlackChannelApiError);
    expect(mock.methods()).not.toContain("chat.postMessage");
  });
});

describe("createE2eSlackChannel token handling", () => {
  it("sends the token only as a Bearer header, only to https://slack.com/api/", async () => {
    const seen: Array<{ url: string; auth: string | null; body: string; redirect: unknown }> = [];
    const { mock } = setup();
    const slack = createE2eSlackChannel(config, async (input, init) => {
      seen.push({
        url: input.href,
        auth: new Headers(init.headers).get("authorization"),
        body: String(init.body),
        redirect: init.redirect,
      });
      return mock.fetch(input, init);
    });
    const { ts } = await slack.post(CHANNEL, "hello");
    await slack.history(CHANNEL);
    await slack.replies(CHANNEL, ts);
    await slack.delete(CHANNEL, ts);
    expect(seen.map((r) => r.url.slice("https://slack.com/api/".length))).toEqual([
      "auth.test",
      "conversations.info",
      "chat.postMessage",
      "conversations.history",
      "conversations.replies",
      "conversations.history",
      "chat.delete",
    ]);
    for (const request of seen) {
      expect(request.url).toMatch(/^https:\/\/slack\.com\/api\/[a-zA-Z.]+$/);
      expect(request.auth).toBe(`Bearer ${TOKEN}`);
      expect(request.url).not.toContain(TOKEN);
      expect(request.body).not.toContain(TOKEN);
      expect(request.redirect).toBe("manual");
    }
    expect(mock.requests.every((r) => r.bearerOk && !r.tokenOutsideHeader)).toBe(true);
  });

  it("treats a redirect as an error and never follows it", async () => {
    const { slack } = setup({
      override: (r) =>
        r.method === "chat.postMessage"
          ? new Response("", { status: 302, headers: { Location: "https://evil.example/" } })
          : undefined,
    });
    const error = (await slack.post(CHANNEL, "x").catch((e: unknown) => e)) as SlackChannelApiError;
    expect(error.code).toBe("http_302");
  });

  it("keeps the marker token out of every error, stack and JSON.stringify", async () => {
    const errors: unknown[] = [];
    const leaky = createMockSlack({
      token: TOKEN,
      botUserId: TEST_SLACK.botUserId,
      channel: { id: CHANNEL, name: "itsupport-e2e", is_general: false },
      override: (r) =>
        r.method === "auth.test"
          ? undefined
          : r.method === "conversations.info"
            ? undefined
            : {
                ok: false,
                error: TOKEN,
                echo: TOKEN,
              },
    });
    const slack = createE2eSlackChannel(config, leaky.fetch);
    for (const call of [...calls(slack, CHANNEL), ...calls(slack, OTHER)]) {
      await call().catch((e: unknown) => errors.push(e));
    }
    const thrower = createE2eSlackChannel(config, async () => {
      throw new Error(`boom ${TOKEN}`);
    });
    await thrower.post(CHANNEL, "x").catch((e: unknown) => errors.push(e));
    expect(errors).toHaveLength(9);
    for (const error of errors) {
      const e = error as Error;
      for (const text of [e.message, String(e.stack), JSON.stringify(e), String(e)]) {
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain("MarkerSlackToken");
      }
      expect((e as { cause?: unknown }).cause).toBeUndefined();
    }
  });
});
