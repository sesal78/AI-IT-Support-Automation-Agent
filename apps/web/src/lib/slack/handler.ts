import { verifySlackRequest } from "@ai-it-support/shared";
import {
  checkReviewer,
  InteractionPayloadError,
  parseInteraction,
  type Interaction,
} from "@/lib/slack/interaction";

// POST /api/slack/interactivity (P4-T3c): size cap, signature, payload,
// reviewer allow-list, then `decide`. Logs and security events never hold the
// body, a header, the signing secret or any payload value.

export const MAX_BODY_BYTES = 128 * 1024;

/** What a security event may say about the request: the path and the method only. */
export type RequestSample = { path: string; method: string };

export interface InteractivityDeps {
  signingSecret: string;
  reviewerIds: readonly string[];
  /** The repositories' `recordSecurityEvent`; the source is always `slack`. */
  recordSecurityEvent: (source: string, kind: string, sample: RequestSample) => Promise<void>;
  /** Unix time in whole seconds. */
  nowSeconds: () => number;
  decide: (interaction: Interaction, sample: RequestSample) => Promise<Response>;
}

/** JSON with `cache-control: no-store`, the header every answer of this route carries. */
export const json = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Error class name only: messages and stacks can carry request data.
export const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/** One JSON log line. Callers pass IDs, kinds, outcomes and error class names only. */
export function log(level: "info" | "error", msg: string, fields: Record<string, unknown>): void {
  const line = JSON.stringify({ level, scope: "slack-interactivity", msg, ...fields });
  if (level === "error") console.error(line);
  else console.info(line);
}

/** Records one `slack` security event; a failed write is logged and never changes the answer. */
export async function recordRefusal(
  record: InteractivityDeps["recordSecurityEvent"],
  kind: string,
  sample: RequestSample,
): Promise<void> {
  try {
    await record("slack", kind, { path: sample.path, method: sample.method });
  } catch (error) {
    log("error", "security event lost", { kind, error: errorName(error) });
  }
}

/**
 * The raw body text, or null when it is over MAX_BODY_BYTES. A declared
 * content-length over the cap is refused before any read; otherwise the stream
 * is counted and the read stops at the first chunk past the cap.
 */
async function readCappedBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createInteractivityHandler(deps: InteractivityDeps) {
  return async (request: Request): Promise<Response> => {
    const sample = { path: new URL(request.url).pathname.slice(0, 200), method: request.method };
    const refuse = async (status: number, error: string, kind: string) => {
      await recordRefusal(deps.recordSecurityEvent, kind, sample);
      return json({ error }, status);
    };
    try {
      const body = await readCappedBody(request);
      if (body === null) return await refuse(413, "too_large", "body_too_large");

      // The HMAC runs on the body exactly as received, before any parsing.
      const verified = verifySlackRequest({
        secret: deps.signingSecret,
        headers: request.headers,
        body,
        nowSeconds: deps.nowSeconds(),
      });
      // Same status, body and headers for every reason.
      if (!verified.ok) return await refuse(401, "unauthorized", verified.reason);

      let interaction: Interaction;
      try {
        interaction = parseInteraction(body, request.headers.get("content-type"));
      } catch (error) {
        if (!(error instanceof InteractionPayloadError)) throw error;
        return await refuse(400, "bad_payload", "bad_payload");
      }

      const reviewer = checkReviewer(interaction, deps.reviewerIds);
      if (!reviewer.allowed) return await refuse(403, "forbidden", reviewer.kind);

      return await deps.decide(interaction, sample);
    } catch (error) {
      log("error", "interaction failed", { error: errorName(error) });
      return json({ error: "internal_error" }, 500);
    }
  };
}
