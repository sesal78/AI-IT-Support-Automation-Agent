import { assertHeaderSafe, parseRecipient } from "./headers.js";

/**
 * A failed Resend call. `code` is `http_<status>`, `network`, `timeout`,
 * `redirect` or `bad_response`. The error never holds the API key, the body or
 * a cause.
 */
export class EmailProviderError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Resend send failed: ${code}`);
    this.name = "EmailProviderError";
    this.code = code;
  }
}

export interface ResendClientOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout; 10 seconds by default. */
  timeoutMs?: number;
}

export interface SendEmailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
}

export interface ResendClient {
  send(input: SendEmailInput): Promise<{ id: string }>;
}

const URL_SEND = "https://api.resend.com/emails";
const MAX_REQUESTS = 3;
const TRANSIENT_WAITS = [1000, 2000];
const RETRY_AFTER_MAX_S = 30;
const API_KEY = /^re_[A-Za-z0-9_]{20,}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{1,256}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,100}$/;

type Attempt =
  | { kind: "done"; id: string }
  | { kind: "retry"; code: string; waitMs?: number }
  | { kind: "fail"; code: string };

/** Retry-After in ms: 1-3 digits of at least 1 s, capped at 30 s; anything else is 1 s. */
function retryAfterMs(header: string | null): number {
  const seconds = header !== null && /^\d{1,3}$/.test(header) ? Number(header) : 0;
  return Math.min(Math.max(seconds, 1), RETRY_AFTER_MAX_S) * 1000;
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
  try {
    const parsed: unknown = JSON.parse(text);
    const id = (parsed as { id?: unknown } | null)?.id;
    if (typeof id === "string" && PROVIDER_ID.test(id)) return { kind: "done", id };
  } catch {
    // Falls through to bad_response; the parse error may quote the body.
  }
  return { kind: "fail", code: "bad_response" };
}

/** A Resend client for one POST /emails, with bounded retries. */
export function createResendClient(options: ResendClientOptions): ResendClient {
  if (typeof options.apiKey !== "string" || !API_KEY.test(options.apiKey)) {
    throw new TypeError("Resend client: apiKey must be a Resend API key");
  }
  const apiKey = options.apiKey;
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 10_000;

  /** One request, read to the end within the timeout. It never throws. */
  async function attempt(body: string, idempotencyKey: string): Promise<Attempt> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("timeout"));
      }, timeoutMs);
    });
    try {
      const read = (async () => {
        const res = await fetch(URL_SEND, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body,
          redirect: "manual",
          signal: controller.signal,
        });
        return { res, text: await res.text() };
      })();
      read.catch(() => {}); // A late failure after the timeout is not an unhandled rejection.
      const { res, text } = await Promise.race([read, timeout]);
      return classify(res, text);
    } catch {
      // The error itself is dropped: it may quote the request.
      return { kind: "retry", code: timedOut ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async send({ from, to, subject, text, html, idempotencyKey }) {
      // Every check runs before any request.
      const checkedFrom = parseRecipient(from, "from");
      const checkedTo = parseRecipient(to, "to");
      assertHeaderSafe(subject, "subject");
      assertHeaderSafe(idempotencyKey, "idempotencyKey");
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new TypeError("Resend client: idempotencyKey has an invalid form");
      }
      const body = JSON.stringify({ from: checkedFrom, to: [checkedTo], subject, text, html });
      let transient = 0;
      for (let request = 1; ; request += 1) {
        const result = await attempt(body, idempotencyKey);
        if (result.kind === "done") return { id: result.id };
        if (result.kind === "fail" || request >= MAX_REQUESTS) {
          throw new EmailProviderError(result.code);
        }
        await sleep(result.waitMs ?? TRANSIENT_WAITS[transient++]!);
      }
    },
  };
}
