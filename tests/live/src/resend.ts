// Guarded Resend helper for the live suite (P5-T8c). It holds the second,
// full-access read key (resolved point 14), so it sends one method only, GET,
// to the fixed API origin, never follows a redirect, and puts no response body,
// header or key into an error.
import { z } from "zod";
import type { ResendConfig } from "./config.ts";

/** The only origin the helper talks to. */
export const RESEND_API_ORIGIN = "https://api.resend.com";

export type ResendGuardReason = "config_missing" | "bad_argument";

/** Thrown for every refused call. Names the reason only, never a value. */
export class ResendGuardError extends Error {
  override readonly name = "ResendGuardError";
  readonly reason: ResendGuardReason;
  constructor(reason: ResendGuardReason) {
    super(`Resend guard: ${reason}`);
    this.reason = reason;
  }
}

/** A call that failed after the guard let it through. Names the operation and a status only. */
export class ResendApiError extends Error {
  override readonly name = "ResendApiError";
  readonly operation: string;
  readonly status: number;
  constructor(operation: string, status: number) {
    super(`${operation}: ${status === 0 ? "bad_response" : `status ${status}`}`);
    this.operation = operation;
    this.status = status;
  }
}

/** One sent email, as the read endpoint reports it. */
export interface ResendEmail {
  /** For example `sent` or `delivered`. */
  readonly lastEvent: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
  /** Resend returns null when the message has no text part. */
  readonly text: string | null;
}

export interface E2eResend {
  /** `GET /emails/<id>`. The one method this helper ever sends. */
  getEmail(id: string): Promise<ResendEmail>;
}

// A Resend email id: letters, digits, `_` and `-`, at most 64 characters (a
// UUID today). No `.`, `/`, `?` or space can reach the path.
const EMAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

// The fields the live scenarios read. Resend sends many more (`from`,
// `created_at`, `bcc`, …), so unknown keys pass through unchecked.
const emailSchema = z.looseObject({
  to: z.array(z.string().min(1).max(320)).min(1),
  subject: z.string(),
  html: z.string(),
  text: z.string().nullable(),
  last_event: z.string().regex(/^[a-z_]{1,40}$/),
});

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/**
 * Builds the helper. Nothing is checked until a method runs; a missing read key
 * or a malformed id is then refused before any request. The request goes to the
 * constant origin, so a path built from a validated id cannot leave it.
 */
export function createE2eResend(config: ResendConfig, fetchImpl: FetchLike): E2eResend {
  function credentials(): string {
    if (config.readKey === undefined) throw new ResendGuardError("config_missing");
    return `Bearer ${config.readKey}`;
  }

  return {
    async getEmail(id) {
      const authorization = credentials();
      if (typeof id !== "string" || !EMAIL_ID.test(id)) {
        throw new ResendGuardError("bad_argument");
      }
      const url = new URL(`/emails/${id}`, RESEND_API_ORIGIN);
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/json", Authorization: authorization },
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
        text = await response.text();
      } catch {
        throw new ResendApiError("getEmail", 0);
      }
      // A redirect is reported as itself and never followed: the key goes to
      // the fixed origin only.
      if (response.status < 200 || response.status > 299) {
        throw new ResendApiError("getEmail", response.status);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ResendApiError("getEmail", 0);
      }
      const parsed = emailSchema.safeParse(json);
      if (!parsed.success) throw new ResendApiError("getEmail", 0);
      return {
        lastEvent: parsed.data.last_event,
        to: parsed.data.to,
        subject: parsed.data.subject,
        html: parsed.data.html,
        text: parsed.data.text,
      };
    },
  };
}
