// In-process stand-in for Trigger.dev wait tokens (P4-T9a, P4-T9c). TEST CODE
// ONLY: never import it from `src`. It does not import vitest, so the local
// runner (Playwright worker) can load it too.
//
// It models what the Trigger.dev docs state for wait.createToken and
// wait.forToken: an idempotent create returns the same token; forToken waits
// until the token is completed (ok: true) or timed out (ok: false), and a
// token that is already settled returns at once. Timeouts never fire on their
// own: a test calls timeOut(). Every token's url and publicAccessToken hold
// the broker's `marker`, so a test can forbid it in every outbound request.
import { randomBytes } from "node:crypto";
import type { ReviewWait } from "../src/trigger/review-ticket.js";

export type TokenState = "waiting" | "completed" | "timed_out";

export interface BrokerToken {
  id: string;
  idempotencyKey: string;
  timeout: string;
  tags: string[];
  state: TokenState;
  /** The data passed to complete(); the review task never reads it. */
  output?: unknown;
}

export interface TokenBroker extends ReviewWait {
  /** A random string inside every token url and publicAccessToken. */
  readonly marker: string;
  /** Completes a waiting token. False for an unknown token; a settled token stays as it is. */
  complete(tokenId: string, output?: unknown): boolean;
  /** Times a waiting token out. False for an unknown token; a settled token stays as it is. */
  timeOut(tokenId: string): boolean;
  /** Snapshot of the token, or undefined. */
  get(tokenId: string): BrokerToken | undefined;
  /** Snapshot of every token, oldest first. */
  tokens(): BrokerToken[];
  /** forToken calls still waiting on the token. */
  waiters(tokenId: string): number;
}

export function createTokenBroker(): TokenBroker {
  const marker = `wtk${randomBytes(8).toString("hex")}`;
  const tokens = new Map<string, BrokerToken>();
  const byKey = new Map<string, string>();
  const pending = new Map<string, Array<(result: { ok: boolean }) => void>>();

  function settle(tokenId: string, state: Exclude<TokenState, "waiting">, output?: unknown) {
    const token = tokens.get(tokenId);
    if (!token) return false;
    if (token.state !== "waiting") return true;
    token.state = state;
    if (state === "completed") token.output = output;
    const waiting = pending.get(tokenId) ?? [];
    pending.delete(tokenId);
    for (const resolve of waiting) resolve({ ok: state === "completed" });
    return true;
  }

  return {
    marker,
    async createToken({ timeout, idempotencyKey, tags }) {
      let id = byKey.get(idempotencyKey);
      if (id === undefined) {
        id = `waitpoint_${randomBytes(12).toString("hex")}`;
        byKey.set(idempotencyKey, id);
        tokens.set(id, { id, idempotencyKey, timeout, tags: [...tags], state: "waiting" });
      }
      return {
        id,
        url: `https://api.trigger.dev/api/v1/waitpoints/tokens/${id}/callback/${marker}`,
        publicAccessToken: `${marker}.${id}`,
      };
    },
    forToken(tokenId) {
      const token = tokens.get(tokenId);
      if (!token) return Promise.reject(new Error("token broker: unknown token"));
      if (token.state !== "waiting") return Promise.resolve({ ok: token.state === "completed" });
      return new Promise((resolve) => {
        pending.set(tokenId, [...(pending.get(tokenId) ?? []), resolve]);
      });
    },
    complete: (tokenId, output) => settle(tokenId, "completed", output),
    timeOut: (tokenId) => settle(tokenId, "timed_out"),
    get(tokenId) {
      const token = tokens.get(tokenId);
      return token && { ...token, tags: [...token.tags] };
    },
    tokens: () => [...tokens.values()].map((token) => ({ ...token, tags: [...token.tags] })),
    waiters: (tokenId) => pending.get(tokenId)?.length ?? 0,
  };
}
