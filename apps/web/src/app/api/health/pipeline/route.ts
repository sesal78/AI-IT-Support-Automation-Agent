import { createHash, timingSafeEqual } from "node:crypto";
import type { healthcheck } from "@ai-it-support/pipeline";
import { tasks } from "@trigger.dev/sdk";
import { env } from "@/env";

// Hashing both sides gives equal-length buffers, so timingSafeEqual never
// short-circuits on length and the compare does not leak the token length.
function tokenMatches(provided: string | null): boolean {
  if (provided === null) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(env.ADMIN_HEALTH_TOKEN).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!tokenMatches(request.headers.get("x-admin-token"))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const handle = await tasks.trigger<typeof healthcheck>("healthcheck", { requestedBy: "api" });
    return Response.json({ runId: handle.id }, { status: 202 });
  } catch {
    return Response.json({ error: "pipeline_unavailable" }, { status: 502 });
  }
}
