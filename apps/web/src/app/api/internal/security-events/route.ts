import { internalSecurityEventsSchema } from "@ai-it-support/shared";
import { z } from "zod";
import { errorName, guard, json, methodNotAllowed, repos } from "@/lib/internal/respond";

// Never prerendered: the body reflects the live database.
export const dynamic = "force-dynamic";

const MAX_EVENTS = 500;
const sinceSchema = z.iso.datetime({ offset: true });

/**
 * Security events at or after `since`, newest first, at most 500. The guard
 * runs before the query is read. `since` must appear exactly once as an
 * ISO 8601 time with a zone (`Z` or an offset; encode `+` as `%2B`); a time
 * without a zone is refused, a future time returns an empty list, and other
 * parameters are ignored. The `sample` column is never selected.
 */
export async function GET(request: Request) {
  const refusal = await guard(request);
  if (refusal) return refusal;

  const values = new URL(request.url).searchParams.getAll("since");
  const since = values.length === 1 ? values[0] : undefined;
  if (since === undefined || !sinceSchema.safeParse(since).success) {
    return json({ error: "invalid_since" }, 400);
  }

  try {
    const events = await repos().listSecurityEvents(new Date(since), MAX_EVENTS);
    // Named fields only, so a stray column (`sample`) can never reach the body.
    return json(
      internalSecurityEventsSchema.parse({
        events: events.map(({ source, kind, windowStart, count }) => ({
          source,
          kind,
          windowStart,
          count,
        })),
      }),
    );
  } catch (error) {
    console.error(`[internal-api] security events failed: ${errorName(error)}`);
    return json({ error: "internal_error" }, 500);
  }
}

const notAllowed = methodNotAllowed("GET, HEAD");
export {
  notAllowed as DELETE,
  notAllowed as OPTIONS,
  notAllowed as PATCH,
  notAllowed as POST,
  notAllowed as PUT,
};
