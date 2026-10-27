import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackClient, SlackApiError, type SlackClientOptions } from "./client.js";

// Fake token built from pieces, so no file holds anything shaped like a real one.
const TOKEN = ["xoxb", "0000000000", "test", "fake"].join("-");
const CHANNEL = "C0000000001";

type Call = { url: string; init: RequestInit };
type Reply = Response | Error | "hang";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** A fake fetch that answers from a script and records every call. */
function fakeFetch(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift() ?? new Error("no scripted reply");
    if (reply === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function client(replies: Reply[], extra: Partial<SlackClientOptions> = {}) {
  const { fetch, calls } = fakeFetch(...replies);
  const sleeps: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    sleeps.push(ms);
  });
  return { slack: createSlackClient({ token: TOKEN, fetch, sleep, ...extra }), calls, sleeps };
}

const post = { channel: CHANNEL, text: "hello", blocks: [{ type: "divider" }] };

async function caught(promise: Promise<unknown>): Promise<SlackApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SlackApiError);
    return error as SlackApiError;
  }
  throw new Error("expected a SlackApiError");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("postMessage and updateMessage", () => {
  it("sends one POST with the token, JSON body and manual redirects, and returns the ts", async () => {
    const { slack, calls, sleeps } = client([json(200, { ok: true, ts: "1700000000.000100" })]);
    await expect(slack.postMessage(post)).resolves.toEqual({ ts: "1700000000.000100" });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [Call];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      channel: CHANNEL,
      text: "hello",
      blocks: [{ type: "divider" }],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(sleeps).toEqual([]);
  });

  it("sends threadTs as thread_ts", async () => {
    const { slack, calls } = client([json(200, { ok: true, ts: "1700000000.000200" })]);
    await slack.postMessage({ ...post, threadTs: "1700000000.000100" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      channel: CHANNEL,
      text: "hello",
      blocks: [{ type: "divider" }],
      thread_ts: "1700000000.000100",
    });
  });

  it("sends channel, ts, text and blocks to chat.update", async () => {
    const { slack, calls } = client([json(200, { ok: true, ts: "1700000000.000100" })]);
    await expect(
      slack.updateMessage({ ...post, ts: "1700000000.000100" }),
    ).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("https://slack.com/api/chat.update");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      channel: CHANNEL,
      ts: "1700000000.000100",
      text: "hello",
      blocks: [{ type: "divider" }],
    });
  });

  it.each(["#general", "c0000000001", "C000", ""])(
    "refuses the channel %j before any request",
    async (channel) => {
      const { slack, calls } = client([]);
      await expect(slack.postMessage({ ...post, channel })).rejects.toThrow(TypeError);
      await expect(slack.updateMessage({ ...post, channel, ts: "1.2" })).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(0);
    },
  );

  it.each(["", "abc", "1.2<!channel>"])("refuses the ts %j before any request", async (ts) => {
    const { slack, calls } = client([]);
    await expect(slack.updateMessage({ ...post, ts })).rejects.toThrow(TypeError);
    await expect(slack.postMessage({ ...post, threadTs: ts })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it.each([["xoxp", "0000000000", "fake"].join("-"), "", "xoxb-short", `${TOKEN}\r\nX: y`])(
    "refuses a token that fails the bot token rule, without echoing it",
    (token) => {
      let message = "";
      try {
        createSlackClient({ token, fetch: fakeFetch().fetch });
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/token/);
      if (token !== "") expect(message).not.toContain(token);
    },
  );
});

describe("retries (T4.I.05)", () => {
  it("waits Retry-After on a 429, then succeeds", async () => {
    const { slack, calls, sleeps } = client([
      json(429, { ok: false, error: "ratelimited" }, { "retry-after": "2" }),
      json(200, { ok: true, ts: "1.1" }),
    ]);
    await expect(slack.postMessage(post)).resolves.toEqual({ ts: "1.1" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it.each([
    [undefined, 1000],
    ["abc", 1000],
    ["0", 1000],
    ["1234", 1000],
    ["-1", 1000],
    ["1.5", 1000],
    ["1", 1000],
    ["30", 30000],
    ["31", 30000],
    ["999", 30000],
  ])("Retry-After %j waits %i ms", async (retryAfter, ms) => {
    const headers: Record<string, string> = retryAfter === undefined ? {} : { "retry-after": retryAfter };
    const { slack, sleeps } = client([json(429, {}, headers), json(200, { ok: true, ts: "1.1" })]);
    await slack.postMessage(post);
    expect(sleeps).toEqual([ms]);
  });

  it("waits 1 s then 2 s on 5xx answers", async () => {
    const { slack, calls, sleeps } = client([
      json(500, {}),
      json(502, {}),
      json(200, { ok: true, ts: "1.1" }),
    ]);
    await expect(slack.postMessage(post)).resolves.toEqual({ ts: "1.1" });
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after 3 requests with http_<status>", async () => {
    const { slack, calls, sleeps } = client([json(500, {}), json(500, {}), json(503, {}), json(200, { ok: true, ts: "1.1" })]);
    const error = await caught(slack.postMessage(post));
    expect(error.code).toBe("http_503");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("gives up after three 429s with http_429", async () => {
    const { slack, calls } = client([json(429, {}), json(429, {}), json(429, {})]);
    expect((await caught(slack.postMessage(post))).code).toBe("http_429");
    expect(calls).toHaveLength(3);
  });

  it("retries a network error and gives up with network", async () => {
    const { slack, calls, sleeps } = client([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    expect((await caught(slack.postMessage(post))).code).toBe("network");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("recovers from a network error", async () => {
    const { slack, calls } = client([new TypeError("fetch failed"), json(200, { ok: true, ts: "1.1" })]);
    await expect(slack.postMessage(post)).resolves.toEqual({ ts: "1.1" });
    expect(calls).toHaveLength(2);
  });

  it("throws an ok: false error at once", async () => {
    const { slack, calls, sleeps } = client([json(200, { ok: false, error: "channel_not_found" })]);
    const error = await caught(slack.postMessage(post));
    expect(error.code).toBe("channel_not_found");
    expect(error.method).toBe("chat.postMessage");
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("retries ok: false ratelimited like a 429", async () => {
    const { slack, calls, sleeps } = client([
      json(200, { ok: false, error: "ratelimited" }, { "retry-after": "3" }),
      json(200, { ok: true, ts: "1.1" }),
    ]);
    await expect(slack.postMessage(post)).resolves.toEqual({ ts: "1.1" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it("gives up on ratelimited after 3 requests", async () => {
    const limited = () => json(200, { ok: false, error: "ratelimited" });
    const { slack, calls } = client([limited(), limited(), limited()]);
    expect((await caught(slack.updateMessage({ ...post, ts: "1.1" }))).code).toBe("ratelimited");
    expect(calls).toHaveLength(3);
  });

  it.each([400, 401, 404])("does not retry an HTTP %i", async (status) => {
    const { slack, calls } = client([json(status, {}), json(200, { ok: true, ts: "1.1" })]);
    expect((await caught(slack.postMessage(post))).code).toBe(`http_${status}`);
    expect(calls).toHaveLength(1);
  });

  it.each([301, 302, 307, 308])("refuses a %i redirect without following or retrying", async (status) => {
    const { slack, calls } = client([
      new Response(null, { status, headers: { location: "https://evil.example/" } }),
      json(200, { ok: true, ts: "1.1" }),
    ]);
    expect((await caught(slack.postMessage(post))).code).toBe("redirect");
    expect(calls).toHaveLength(1);
  });

  it("refuses an opaque redirect answer", async () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    const { slack, calls } = client([opaque]);
    expect((await caught(slack.postMessage(post))).code).toBe("redirect");
    expect(calls).toHaveLength(1);
  });

  it("counts a request that does not answer within the timeout as a network error", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch("hang", json(200, { ok: true, ts: "1.1" }));
    const sleeps: number[] = [];
    const slack = createSlackClient({
      token: TOKEN,
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = slack.postMessage(post);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ts: "1.1" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });

  it("times out even when fetch ignores the abort signal, and honours timeoutMs", async () => {
    vi.useFakeTimers();
    const never = vi.fn(() => new Promise<Response>(() => {}));
    const slack = createSlackClient({
      token: TOKEN,
      fetch: never as unknown as typeof globalThis.fetch,
      sleep: async () => {},
      timeoutMs: 500,
    });
    const result = caught(slack.postMessage(post));
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await result).code).toBe("network");
    expect(never).toHaveBeenCalledTimes(3);
  });

  it("uses a real sleep by default", async () => {
    vi.useFakeTimers();
    const { fetch, calls } = fakeFetch(json(500, {}), json(200, { ok: true, ts: "1.1" }));
    const slack = createSlackClient({ token: TOKEN, fetch });
    const result = slack.postMessage(post);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ts: "1.1" });
  });
});

describe("bad responses", () => {
  it.each([
    ["a body that is not JSON", new Response("<html>oops</html>", { status: 200 })],
    ["a post reply without ts", json(200, { ok: true })],
    ["a ts that is not a string", json(200, { ok: true, ts: 5 })],
    ["a JSON body that is not an object", json(200, [1, 2])],
    ["a body without ok", json(200, { ts: "1.1" })],
    ["an error code that is not a short code", json(200, { ok: false, error: "<!channel> bad" })],
    ["a missing error code", json(200, { ok: false })],
  ])("throws bad_response for %s, after 1 request", async (_case, reply) => {
    const { slack, calls } = client([reply, json(200, { ok: true, ts: "1.1" })]);
    expect((await caught(slack.postMessage(post))).code).toBe("bad_response");
    expect(calls).toHaveLength(1);
  });

  it("does not need a ts from chat.update", async () => {
    const { slack } = client([json(200, { ok: true })]);
    await expect(slack.updateMessage({ ...post, ts: "1.1" })).resolves.toBeUndefined();
  });
});

describe("secrets stay out of errors and logs", () => {
  const MARK_TEXT = "MARKER_TEXT_9a8b";
  const MARK_BLOCK = "MARKER_BLOCK_7c6d";
  const MARK_TOKEN = "MARKERTOKEN5e4f";
  const markedToken = ["xoxb", MARK_TOKEN].join("-");
  const markers = [MARK_TEXT, MARK_BLOCK, MARK_TOKEN];
  const markedPost = {
    channel: CHANNEL,
    text: MARK_TEXT,
    blocks: [{ type: "section", text: { type: "plain_text", text: MARK_BLOCK } }],
  };

  it.each<[string, Reply[]]>([
    ["ok: false", [json(200, { ok: false, error: "invalid_auth" })]],
    ["three 500s", [json(500, { echo: MARK_TEXT }), json(500, {}), json(500, {})]],
    ["three network errors", [0, 1, 2].map(() => new TypeError(`fetch failed ${MARK_TOKEN} ${MARK_TEXT}`))],
    ["bad JSON echoing the request", [new Response(`${MARK_TOKEN} ${MARK_TEXT}`, { status: 200 })]],
    ["a redirect", [new Response(null, { status: 302, headers: { location: `https://x/${MARK_TOKEN}` } })]],
  ])("holds no marker after %s", async (_case, replies) => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const { fetch } = fakeFetch(...replies);
    const slack = createSlackClient({ token: markedToken, fetch, sleep: async () => {} });
    const error = await caught(slack.postMessage(markedPost));
    const views = [
      error.message,
      String(error.stack),
      String(error),
      JSON.stringify(error),
      JSON.stringify(Object.getOwnPropertyNames(error).map((k) => String((error as never)[k]))),
      String(error.cause),
      ...spies.flatMap((spy) => spy.mock.calls.map((c) => JSON.stringify(c))),
    ];
    for (const view of views) for (const marker of markers) expect(view).not.toContain(marker);
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error).sort()).toEqual(["code", "method", "name"]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("holds no marker when the token is refused", () => {
    const token = `xoxp-${MARK_TOKEN}`;
    try {
      createSlackClient({ token, fetch: fakeFetch().fetch });
    } catch (error) {
      expect(String((error as Error).stack)).not.toContain(MARK_TOKEN);
      return;
    }
    throw new Error("expected a TypeError");
  });
});
