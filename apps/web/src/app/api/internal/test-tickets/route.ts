import {
  TestOverridesError,
  effectiveTestOverrides,
  testOverridesSchema,
  ticketSubmissionSchema,
} from "@ai-it-support/shared";
import { z } from "zod";
import { env } from "@/env";
import { createAndEnqueueTicket } from "@/lib/intake/create-ticket";
import { namespacedKey } from "@/lib/intake/request";
import { e2eOnlyNotFound } from "@/lib/internal/e2e-only";
import { guard, json, methodNotAllowed, repos } from "@/lib/internal/respond";

// Never prerendered: the answer depends on the server's mode.
export const dynamic = "force-dynamic";

// The form's rules for the visitor's fields; no Turnstile token. Strict, so a
// smuggled `is_test`, `source`, `idempotency_key` or `__proto__` is a 400.
const testTicketSchema = ticketSubmissionSchema
  .omit({ turnstileToken: true })
  .extend({
    testId: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
    testOverrides: testOverridesSchema.optional(),
  })
  .strict();

/**
 * Creates a test ticket (`is_test = true`, source `web`, key `test:<testId>`)
 * through the shared intake function. No Turnstile and no IP rate limit; the
 * token guard is the gate. Logs never include the request body.
 */
export async function POST(request: Request) {
  if (!env.E2E_MODE) return e2eOnlyNotFound(request, "test_tickets_disabled");
  const refusal = await guard(request);
  if (refusal) return refusal;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_body", fieldErrors: {} }, 400);
  }
  const parsed = testTicketSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      { error: "invalid_body", fieldErrors: z.flattenError(parsed.error).fieldErrors },
      400,
    );
  }
  const { testId, testOverrides: requested, ...submission } = parsed.data;

  let testOverrides;
  try {
    testOverrides = effectiveTestOverrides({ e2eMode: env.E2E_MODE, isTest: true, requested });
  } catch (error) {
    if (error instanceof TestOverridesError)
      return json({ error: "invalid_body", fieldErrors: {} }, 400);
    throw error;
  }

  const result = await createAndEnqueueTicket(repos(), {
    ...submission,
    idempotencyKey: namespacedKey("test", testId),
    isTest: true,
    testOverrides,
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

/** Disabled: 404 for every method. Enabled: the guard, then 405. */
function other(allow: string) {
  const notAllowed = methodNotAllowed(allow);
  return async (request: Request): Promise<Response> =>
    env.E2E_MODE ? notAllowed(request) : e2eOnlyNotFound(request, "test_tickets_disabled");
}

const rest = other("POST");
export { rest as DELETE, rest as GET, rest as HEAD, rest as OPTIONS, rest as PATCH, rest as PUT };
