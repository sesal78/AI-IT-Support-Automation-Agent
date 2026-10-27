/**
 * In-process mock of the Slack Web API (test support only). Its `fetch`
 * answers `https://slack.com/api/<method>`, and hands any other URL to
 * `fallback` (or refuses it). It records what each request looked like, and
 * compares the token instead of storing it.
 */
export interface MockSlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  blocks?: unknown[];
  thread_ts?: string;
}

export interface MockSlackRequest {
  readonly url: string;
  readonly method: string;
  readonly params: Readonly<Record<string, string>>;
  /** Authorization was exactly `Bearer <token>`. */
  readonly bearerOk: boolean;
  /** The token appeared in the URL or the body. */
  readonly tokenOutsideHeader: boolean;
}

export interface MockSlackOptions {
  readonly token: string;
  readonly botUserId: string;
  /** What `conversations.info` returns for `channel.id`; `is_general` left out when undefined. */
  readonly channel: { readonly id: string; readonly name: string; readonly is_general?: boolean };
  readonly messages?: MockSlackMessage[];
  /** Messages per history or replies page (default 200). */
  readonly pageSize?: number;
  /** Runs first; a returned body (or Response) replaces the default answer. */
  readonly override?: (request: MockSlackRequest) => unknown;
  /** Where non-Slack URLs go (for example the real fetch to a local mock app). */
  readonly fallback?: (input: URL, init: RequestInit) => Promise<Response>;
}

export interface MockSlack {
  readonly fetch: (input: URL, init: RequestInit) => Promise<Response>;
  readonly requests: MockSlackRequest[];
  readonly messages: MockSlackMessage[];
  /** Methods called, in order. */
  methods(): string[];
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

export function createMockSlack(options: MockSlackOptions): MockSlack {
  const requests: MockSlackRequest[] = [];
  const messages = options.messages ?? [];
  const pageSize = options.pageSize ?? 200;
  let seq = 1;

  function page(list: MockSlackMessage[], cursor: string | undefined) {
    const start = cursor ? Number(cursor) : 0;
    const slice = list.slice(start, start + pageSize);
    const next = start + pageSize < list.length ? String(start + pageSize) : "";
    return {
      ok: true,
      messages: slice,
      has_more: next !== "",
      response_metadata: { next_cursor: next },
    };
  }

  function answer(method: string, p: Record<string, string>): unknown {
    if (method === "auth.test")
      return { ok: true, user_id: options.botUserId, team_id: "T0000000000" };
    if (p.channel !== options.channel.id) return { ok: false, error: "channel_not_found" };
    switch (method) {
      case "conversations.info": {
        const { is_general, ...rest } = options.channel;
        return {
          ok: true,
          channel: { ...rest, ...(is_general === undefined ? {} : { is_general }) },
        };
      }
      case "conversations.history": {
        const n = (ts: string | undefined, fallback: number) => (ts ? Number(ts) : fallback);
        const inclusive = p.inclusive === "true";
        const list = messages
          .filter((m) => m.thread_ts === undefined || m.thread_ts === m.ts)
          .filter((m) => {
            const t = Number(m.ts);
            const lo = n(p.oldest, -Infinity);
            const hi = n(p.latest, Infinity);
            return (inclusive ? t >= lo : t > lo) && (inclusive ? t <= hi : t < hi);
          })
          .sort((a, b) => Number(b.ts) - Number(a.ts));
        return page(list, p.cursor);
      }
      case "conversations.replies": {
        const list = messages
          .filter((m) => m.ts === p.ts || m.thread_ts === p.ts)
          .sort((a, b) => Number(a.ts) - Number(b.ts));
        return list.length === 0 ? { ok: false, error: "thread_not_found" } : page(list, p.cursor);
      }
      case "chat.postMessage": {
        const ts = `1700000000.${String(seq++).padStart(6, "0")}`;
        messages.push({ ts, user: options.botUserId, bot_id: "B0000000000", text: p.text ?? "" });
        return { ok: true, channel: p.channel, ts };
      }
      case "chat.delete": {
        const i = messages.findIndex((m) => m.ts === p.ts);
        if (i < 0) return { ok: false, error: "message_not_found" };
        if (messages[i]!.user !== options.botUserId)
          return { ok: false, error: "cant_delete_message" };
        messages.splice(i, 1);
        return { ok: true, channel: p.channel, ts: p.ts };
      }
      default:
        return { ok: false, error: "unknown_method" };
    }
  }

  async function mockFetch(input: URL, init: RequestInit): Promise<Response> {
    const url = new URL(input);
    if (url.origin !== "https://slack.com" || !url.pathname.startsWith("/api/")) {
      if (options.fallback) return options.fallback(input, init);
      throw new TypeError("mock-slack: refused a non-Slack URL");
    }
    const body = typeof init.body === "string" ? init.body : "";
    const params = Object.fromEntries(new URLSearchParams(body));
    const authorization = new Headers(init.headers).get("authorization");
    const request: MockSlackRequest = {
      url: url.href,
      method: url.pathname.slice("/api/".length),
      params,
      bearerOk: authorization === `Bearer ${options.token}`,
      tokenOutsideHeader: url.href.includes(options.token) || body.includes(options.token),
    };
    requests.push(request);
    const replaced = options.override?.(request);
    if (replaced instanceof Response) return replaced;
    if (replaced !== undefined) return json(replaced);
    if (!request.bearerOk) return json({ ok: false, error: "invalid_auth" });
    return json(answer(request.method, params));
  }

  return {
    fetch: mockFetch,
    requests,
    messages,
    methods: () => requests.map((r) => r.method),
  };
}
