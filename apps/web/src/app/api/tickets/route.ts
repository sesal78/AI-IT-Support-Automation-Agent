import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import { ticketSubmissionSchema } from "@ai-it-support/shared";
import { z } from "zod";
import { env } from "@/env";
import { createAndEnqueueTicket } from "@/lib/intake/create-ticket";
import { createRateLimiter } from "@/lib/intake/rate-limit";
import { clientIp, idempotencyKey } from "@/lib/intake/request";
import { verifyTurnstile } from "@/lib/intake/turnstile";

// 5 submits per IP per 10 minutes, in memory (single replica).
const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });

let repositories: Repositories | undefined;
function repos(): Repositories {
  repositories ??= createRepositories(
    createDbClient({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_DB_SCHEMA: env.SUPABASE_DB_SCHEMA,
    }),
  );
  return repositories;
}

const json = (body: unknown, status: number) => Response.json(body, { status });

// Logs never include the request body (name, email, title, description) or the Turnstile token.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_body", fieldErrors: {} }, 400);
  }

  const parsed = ticketSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    const { fieldErrors } = z.flattenError(parsed.error);
    const otherFields = Object.keys(fieldErrors).filter((field) => field !== "turnstileToken");
    // A body that is valid apart from a missing token is a failed challenge.
    if (otherFields.length === 0 && "turnstileToken" in fieldErrors) {
      return json({ error: "turnstile_failed" }, 403);
    }
    return json({ error: "invalid_body", fieldErrors }, 400);
  }
  const submission = parsed.data;

  const ip = clientIp(request.headers);
  const passed = await verifyTurnstile(submission.turnstileToken, ip, {
    secret: env.TURNSTILE_SECRET_KEY,
  });
  if (!passed) return json({ error: "turnstile_failed" }, 403);

  if (!limiter.hit(ip ?? "unknown")) return json({ error: "rate_limited" }, 429);

  const result = await createAndEnqueueTicket(repos(), {
    name: submission.name,
    email: submission.email,
    department: submission.department,
    title: submission.title,
    description: submission.description,
    idempotencyKey: idempotencyKey(request.headers, submission),
    // Only the server's own mode decides this. The body is never consulted.
    isTest: env.E2E_MODE,
  });
  switch (result.outcome) {
    case "store_failed":
      return json({ error: "internal_error" }, 500);
    case "duplicate":
      return json({ ticketId: result.ticketId, queued: true, duplicate: true }, 201);
    case "queued":
      return json({ ticketId: result.ticketId, queued: true }, 201);
    case "enqueue_failed":
      return json({ ticketId: result.ticketId, queued: false }, 201);
  }
}
