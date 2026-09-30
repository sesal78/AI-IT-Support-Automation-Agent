import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import {
  INTAKE_TICKET_TASK_ID,
  ticketSubmissionSchema,
  type IntakeTicketPayload,
} from "@ai-it-support/shared";
import { tasks, type Task } from "@trigger.dev/sdk";
import { z } from "zod";
import { env } from "@/env";
import { createRateLimiter } from "@/lib/intake/rate-limit";
import { clientIp, idempotencyKey } from "@/lib/intake/request";
import { verifyTurnstile } from "@/lib/intake/turnstile";

// The intake task lives in services/pipeline (P2-T6); it is triggered by id
// with a locally declared payload type so this route does not import it.
type IntakeTicketTask = Task<typeof INTAKE_TICKET_TASK_ID, IntakeTicketPayload>;

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

// Error class name only: messages and stacks can carry request data.
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

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

  const db = repos();
  let ticketId: string;
  let created: boolean;
  try {
    const result = await db.createTicket({
      source: "web",
      raw_title: submission.title,
      raw_description: submission.description,
      requester_email: submission.email,
      requester_name: submission.name,
      department: submission.department,
      idempotency_key: idempotencyKey(request.headers, submission),
    });
    ticketId = result.ticket.id;
    created = result.created;
    if (created) await db.addEvent(ticketId, "received");
  } catch (error) {
    console.error(`[api/tickets] store failed: ${errorName(error)}`);
    return json({ error: "internal_error" }, 500);
  }

  // A repeated idempotency key returns the existing ticket; its task was already triggered.
  if (!created) return json({ ticketId, queued: true, duplicate: true }, 201);

  try {
    await tasks.trigger<IntakeTicketTask>(INTAKE_TICKET_TASK_ID, { ticketId });
    return json({ ticketId, queued: true }, 201);
  } catch (error) {
    console.error(`[api/tickets] enqueue failed for ticket ${ticketId}: ${errorName(error)}`);
    try {
      await db.addEvent(ticketId, "enqueue_failed", { error: errorName(error) });
    } catch (eventError) {
      console.error(
        `[api/tickets] recording enqueue_failed failed for ticket ${ticketId}: ${errorName(eventError)}`,
      );
    }
    return json({ ticketId, queued: false }, 201);
  }
}
