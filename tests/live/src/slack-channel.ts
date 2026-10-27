// Guarded Slack helper for the live suite. It will hold the real bot token and
// reach a real workspace, so it trusts nothing until auth.test and
// conversations.info prove the configured channel is #itsupport-e2e, and then
// touches that one channel only (phase 4 resolved point 11, T4.S.06).
import { slackChannelId, slackUserId } from "@ai-it-support/shared";
import { z } from "zod";
import { errorClassName } from "./client.ts";
import { LiveConfigError, type LiveConfig } from "./config.ts";

/** The only channel name the helper accepts, exactly (no case or space variants). */
export const E2E_CHANNEL_NAME = "itsupport-e2e";
/** The only origin and path the token is ever sent to. */
const SLACK_API = "https://slack.com/api/";
/** Most pages one history or replies read follows; a cursor that never ends fails loudly. */
export const MAX_PAGES = 20;
const PAGE_LIMIT = 200;
// A Slack message timestamp, or a whole-second bound such as `0`.
const TS = /^[0-9]{1,12}(\.[0-9]{1,6})?$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

export type GuardReason =
  | "auth_failed"
  | "channel_info_failed"
  | "wrong_channel"
  | "is_general"
  | "channel_refused"
  | "not_bot_message";

/** Thrown for every refused call. Names the reason only, never a value. */
export class SlackChannelGuardError extends Error {
  override readonly name = "SlackChannelGuardError";
  readonly reason: GuardReason;
  constructor(reason: GuardReason) {
    super(`Slack channel guard: ${reason}`);
    this.reason = reason;
  }
}

/** A Slack call that failed after the guard let it through. Names the method and a code only. */
export class SlackChannelApiError extends Error {
  override readonly name = "SlackChannelApiError";
  readonly method: string;
  readonly code: string;
  constructor(method: string, code: string) {
    super(`${method}: ${code}`);
    this.method = method;
    this.code = code;
  }
}

export interface SlackMessage {
  readonly ts: string;
  readonly user: string | undefined;
  readonly bot_id: string | undefined;
  readonly text: string;
  readonly blocks: readonly unknown[] | undefined;
  readonly thread_ts: string | undefined;
}

export interface E2eSlackChannel {
  /** Runs the guard (once; the result, pass or fail, is kept) and returns the verified IDs. */
  verify(): Promise<{ readonly channelId: string; readonly botUserId: string }>;
  /** `conversations.history` from `oldest`, following the cursor (at most MAX_PAGES pages). */
  history(channel: string, options?: { readonly oldest?: string }): Promise<SlackMessage[]>;
  /** `conversations.replies`: the thread of `ts`, parent first. */
  replies(channel: string, ts: string): Promise<SlackMessage[]>;
  post(channel: string, text: string): Promise<{ readonly ts: string }>;
  /** Deletes a top-level message, only when its `user` is the bot user. */
  delete(channel: string, ts: string): Promise<void>;
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;
type SlackMethod =
  | "auth.test"
  | "conversations.info"
  | "conversations.history"
  | "conversations.replies"
  | "chat.postMessage"
  | "chat.delete";

const messageSchema = z.object({
  ts: z.string().regex(TS),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().default(""),
  blocks: z.array(z.unknown()).optional(),
  thread_ts: z.string().optional(),
});
const pageSchema = z.object({
  messages: z.array(messageSchema),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
const authSchema = z.object({ user_id: slackUserId() });
const infoSchema = z.object({
  channel: z.object({ id: z.string(), name: z.string(), is_general: z.boolean() }),
});
const postSchema = z.object({ ts: z.string().regex(TS) });

const toMessage = (m: z.infer<typeof messageSchema>): SlackMessage => ({
  ts: m.ts,
  user: m.user,
  bot_id: m.bot_id,
  text: m.text,
  blocks: m.blocks,
  thread_ts: m.thread_ts,
});

/**
 * Builds the guarded helper. Needs E2E_SLACK_BOT_TOKEN and E2E_SLACK_CHANNEL_ID
 * (a scenario checks them first and reports not_run). Every method refuses a
 * channel other than the configured one before any request, then waits for
 * the guard; a failed guard refuses every later call without retrying.
 */
export function createE2eSlackChannel(config: LiveConfig, fetch: FetchLike): E2eSlackChannel {
  const { botToken, channelId } = config.slack;
  if (botToken === undefined || channelId === undefined) {
    throw new LiveConfigError("E2E_SLACK_BOT_TOKEN and E2E_SLACK_CHANNEL_ID are required");
  }
  if (!slackChannelId().safeParse(channelId).success) {
    throw new LiveConfigError("E2E_SLACK_CHANNEL_ID: must be a Slack channel ID");
  }

  async function call(method: SlackMethod, params: Record<string, string>): Promise<unknown> {
    const url = new URL(method, SLACK_API);
    if (url.origin !== "https://slack.com" || url.pathname !== `/api/${method}`) {
      throw new SlackChannelApiError(method, "origin_refused");
    }
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: new URLSearchParams(params).toString(),
        redirect: "manual",
      });
      text = await response.text();
    } catch (error) {
      // The cause may quote a header; only its class name survives.
      throw new SlackChannelApiError(method, `transport_${errorClassName(error)}`);
    }
    if (response.status !== 200) throw new SlackChannelApiError(method, `http_${response.status}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SlackChannelApiError(method, "bad_response");
    }
    const body = json as { ok?: unknown; error?: unknown };
    if (typeof json !== "object" || json === null || body.ok !== true) {
      const code = typeof body?.error === "string" && ERROR_CODE.test(body.error) ? body.error : "";
      throw new SlackChannelApiError(method, code === "" ? "not_ok" : code);
    }
    return json;
  }

  async function runGuard(): Promise<{ channelId: string; botUserId: string }> {
    let botUserId: string;
    try {
      const auth = authSchema.safeParse(await call("auth.test", {}));
      if (!auth.success) throw new SlackChannelGuardError("auth_failed");
      botUserId = auth.data.user_id;
    } catch {
      throw new SlackChannelGuardError("auth_failed");
    }
    let info: z.infer<typeof infoSchema>;
    try {
      const parsed = infoSchema.safeParse(
        await call("conversations.info", { channel: channelId! }),
      );
      if (!parsed.success) throw new SlackChannelGuardError("channel_info_failed");
      info = parsed.data;
    } catch {
      throw new SlackChannelGuardError("channel_info_failed");
    }
    if (info.channel.id !== channelId || info.channel.name !== E2E_CHANNEL_NAME) {
      throw new SlackChannelGuardError("wrong_channel");
    }
    if (info.channel.is_general !== false) throw new SlackChannelGuardError("is_general");
    return { channelId: channelId!, botUserId };
  }

  let guard: Promise<{ channelId: string; botUserId: string }> | undefined;
  const verify = () => {
    guard ??= runGuard();
    return guard;
  };

  /** Refuses any channel but the configured one before any request, then waits for the guard. */
  async function guarded(channel: unknown) {
    if (typeof channel !== "string" || channel !== channelId) {
      throw new SlackChannelGuardError("channel_refused");
    }
    const verified = await verify();
    if (channel !== verified.channelId) throw new SlackChannelGuardError("channel_refused");
    return verified;
  }

  const checkTs = (method: string, ts: unknown): string => {
    if (typeof ts !== "string" || !TS.test(ts)) throw new SlackChannelApiError(method, "bad_ts");
    return ts;
  };

  async function pages(
    method: "conversations.history" | "conversations.replies",
    params: Record<string, string>,
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const parsed = pageSchema.safeParse(
        await call(method, { ...params, limit: String(PAGE_LIMIT), ...(cursor ? { cursor } : {}) }),
      );
      if (!parsed.success) throw new SlackChannelApiError(method, "bad_response");
      messages.push(...parsed.data.messages.map(toMessage));
      cursor = parsed.data.response_metadata?.next_cursor ?? "";
      if (cursor === "") return messages;
    }
    throw new SlackChannelApiError(method, "page_cap");
  }

  return {
    verify,
    async history(channel, options = {}) {
      const { channelId: id } = await guarded(channel);
      const params: Record<string, string> = { channel: id };
      if (options.oldest !== undefined) {
        params.oldest = checkTs("conversations.history", options.oldest);
      }
      return pages("conversations.history", params);
    },
    async replies(channel, ts) {
      const { channelId: id } = await guarded(channel);
      return pages("conversations.replies", {
        channel: id,
        ts: checkTs("conversations.replies", ts),
      });
    },
    async post(channel, text) {
      const { channelId: id } = await guarded(channel);
      if (typeof text !== "string" || text === "" || text.length > 4000) {
        throw new SlackChannelApiError("chat.postMessage", "bad_text");
      }
      const posted = postSchema.safeParse(await call("chat.postMessage", { channel: id, text }));
      if (!posted.success) throw new SlackChannelApiError("chat.postMessage", "bad_response");
      return { ts: posted.data.ts };
    },
    async delete(channel, ts) {
      const { channelId: id, botUserId } = await guarded(channel);
      const target = checkTs("chat.delete", ts);
      // One read first: the exact top-level message, and it must be the bot
      // user's own. A thread reply, a missing message or a bot_id-only message
      // (no user) is refused before the delete request.
      const page = pageSchema.safeParse(
        await call("conversations.history", {
          channel: id,
          oldest: target,
          latest: target,
          inclusive: "true",
          limit: "1",
        }),
      );
      if (!page.success) throw new SlackChannelApiError("conversations.history", "bad_response");
      const message = page.data.messages.find((m) => m.ts === target);
      if (message === undefined || message.user === undefined || message.user !== botUserId) {
        throw new SlackChannelGuardError("not_bot_message");
      }
      await call("chat.delete", { channel: id, ts: target });
    },
  };
}
