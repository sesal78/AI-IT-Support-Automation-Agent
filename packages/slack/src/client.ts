import { slackBotToken, slackChannelId } from "@ai-it-support/shared";
import type { SlackBlock } from "./limits.js";

/**
 * A failed Slack Web API call. `code` is Slack's own short error code, or
 * `http_<status>`, `network`, `redirect` or `bad_response`. The error never
 * holds the token, the text, the blocks or a cause.
 */
export class SlackApiError extends Error {
  readonly code: string;
  readonly method: string;

  constructor(method: string, code: string) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackApiError";
    this.code = code;
    this.method = method;
  }
}

export interface SlackClientOptions {
  /** The bot token; it must pass the bot token rule. */
  token: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout; 10 seconds by default. */
  timeoutMs?: number;
}

export interface PostMessageInput {
  channel: string;
  text: string;
  blocks: SlackBlock[];
  threadTs?: string;
}

export interface UpdateMessageInput {
  channel: string;
  ts: string;
  text: string;
  blocks: SlackBlock[];
}

export interface SlackClient {
  postMessage(input: PostMessageInput): Promise<{ ts: string }>;
  updateMessage(input: UpdateMessageInput): Promise<void>;
}

const API = "https://slack.com/api/";
const MAX_REQUESTS = 3;
const TRANSIENT_WAITS = [1000, 2000];
const RETRY_AFTER_MAX_S = 30;
const TS = /^\d+\.\d+$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

/** Retry-After in ms: 1–3 digits of at least 1 s, capped at 30 s; anything else is 1 s. */
function retryAfterMs(header: string | null): number {
  const seconds = header !== null && /^\d{1,3}$/.test(header) ? Number(header) : 0;
  return Math.min(Math.max(seconds, 1), RETRY_AFTER_MAX_S) * 1000;
}

type Attempt =
  | { kind: "done"; body: Record<string, unknown> }
  | { kind: "retry"; code: string; waitMs?: number }
  | { kind: "fail"; code: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function checkChannel(channel: unknown): void {
  if (!slackChannelId().safeParse(channel).success) {
    throw new TypeError("Slack client: channel must be a Slack channel ID");
  }
}

function checkTs(ts: unknown, field: string): void {
  if (typeof ts !== "string" || !TS.test(ts)) {
    throw new TypeError(`Slack client: ${field} must be a Slack message ts`);
  }
}

/** A Slack Web API client for chat.postMessage and chat.update, with bounded retries. */
export function createSlackClient(options: SlackClientOptions): SlackClient {
  if (!slackBotToken().safeParse(options.token).success) {
    throw new TypeError("Slack client: token must be a Slack bot token");
  }
  const token = options.token;
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 10_000;

  /** One request, read to the end within the timeout. It never throws. */
  async function attempt(method: string, body: string): Promise<Attempt> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("timeout"));
      }, timeoutMs);
    });
    try {
      const read = (async () => {
        const res = await fetch(API + method, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body,
          redirect: "manual",
          signal: controller.signal,
        });
        return { res, text: await res.text() };
      })();
      read.catch(() => {}); // A late failure after the timeout is not an unhandled rejection.
      const { res, text } = await Promise.race([read, timedOut]);
      return classify(res, text);
    } catch {
      // Network error or timeout. The error itself is dropped: it may quote the request.
      return { kind: "retry", code: "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  function classify(res: Response, text: string): Attempt {
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return { kind: "fail", code: "redirect" };
    }
    if (res.status === 429) {
      return {
        kind: "retry",
        code: "http_429",
        waitMs: retryAfterMs(res.headers.get("retry-after")),
      };
    }
    if (res.status >= 500) return { kind: "retry", code: `http_${res.status}` };
    if (res.status !== 200) return { kind: "fail", code: `http_${res.status}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "fail", code: "bad_response" };
    }
    if (!isObj(parsed) || typeof parsed.ok !== "boolean")
      return { kind: "fail", code: "bad_response" };
    if (parsed.ok) return { kind: "done", body: parsed };
    const code =
      typeof parsed.error === "string" && ERROR_CODE.test(parsed.error) ? parsed.error : null;
    if (code === null) return { kind: "fail", code: "bad_response" };
    if (code === "ratelimited") {
      return { kind: "retry", code, waitMs: retryAfterMs(res.headers.get("retry-after")) };
    }
    return { kind: "fail", code };
  }

  async function call(method: string, payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    let transient = 0;
    for (let request = 1; ; request += 1) {
      const result = await attempt(method, body);
      if (result.kind === "done") return result.body;
      if (result.kind === "fail" || request >= MAX_REQUESTS) {
        throw new SlackApiError(method, result.code);
      }
      await sleep(result.waitMs ?? TRANSIENT_WAITS[transient++]!);
    }
  }

  return {
    async postMessage({ channel, text, blocks, threadTs }) {
      checkChannel(channel);
      if (threadTs !== undefined) checkTs(threadTs, "threadTs");
      const payload: Record<string, unknown> = { channel, text, blocks };
      if (threadTs !== undefined) payload.thread_ts = threadTs;
      const reply = await call("chat.postMessage", payload);
      if (typeof reply.ts !== "string" || !TS.test(reply.ts)) {
        throw new SlackApiError("chat.postMessage", "bad_response");
      }
      return { ts: reply.ts };
    },
    async updateMessage({ channel, ts, text, blocks }) {
      checkChannel(channel);
      checkTs(ts, "ts");
      await call("chat.update", { channel, ts, text, blocks });
    },
  };
}
