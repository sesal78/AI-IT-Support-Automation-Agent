/** One observation the mock Langfuse API serves (the v2 fields the scenarios read). */
export interface MockObservation {
  readonly id: string;
  readonly sessionId: string;
  readonly model?: string | null;
  readonly usageDetails?: Record<string, number>;
  readonly environment?: string;
  readonly input?: unknown;
  readonly output?: unknown;
  readonly metadata?: unknown;
}

export interface MockLangfuse {
  /** Answers requests to `origin`; any other URL goes to `fallback` (default: the global fetch). */
  readonly fetch: (input: URL, init: RequestInit) => Promise<Response>;
  /** Every request to the Langfuse origin. */
  readonly requests: URL[];
}

/** One clean observation for a ticket, like the sink writes it (redacted input). */
export function cleanObservation(ticketId: string, n = 1): MockObservation {
  return {
    id: `obs-${ticketId}-${n}`,
    sessionId: ticketId,
    model: "mock-model",
    usageDetails: { input: 120, output: 40 },
    environment: "e2e",
    input: "VPN down, contact [REDACTED_EMAIL] or [REDACTED_PHONE]",
    output: { steps: ["Restart the client"] },
    metadata: { provider: "mock", kind: "fix-steps" },
  };
}

/**
 * A mock of `GET /api/public/v2/observations` on `origin` (https, matched by
 * origin only): Basic auth with the given keys (else 401), the `sessionId`
 * filter, and cursor pages of `pageSize` rows. `observations` is read on each
 * request, so rows can follow the mock e2e app's tickets. Test support only.
 */
export function startMockLangfuse(options: {
  readonly origin: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly observations: () => readonly MockObservation[];
  readonly pageSize?: number;
  readonly fallback?: (input: URL, init: RequestInit) => Promise<Response>;
}): MockLangfuse {
  const requests: URL[] = [];
  const pageSize = options.pageSize ?? 2;
  const auth = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}`;
  const fallback = options.fallback ?? ((input, init) => fetch(input, init));
  return {
    requests,
    async fetch(input, init) {
      if (input.origin !== options.origin) return fallback(input, init);
      requests.push(input);
      if (new Headers(init.headers).get("Authorization") !== auth) {
        return Response.json({ message: "unauthorized" }, { status: 401 });
      }
      if (input.pathname !== "/api/public/v2/observations") {
        return Response.json({ message: "not found" }, { status: 404 });
      }
      const session = input.searchParams.get("sessionId");
      const rows = options
        .observations()
        .filter((row) => session === null || row.sessionId === session);
      const page = Number(input.searchParams.get("cursor")?.replace("page", "") ?? "0");
      const data = rows.slice(page * pageSize, (page + 1) * pageSize);
      const more = (page + 1) * pageSize < rows.length;
      return Response.json({ data, meta: more ? { cursor: `page${page + 1}` } : {} });
    },
  };
}
