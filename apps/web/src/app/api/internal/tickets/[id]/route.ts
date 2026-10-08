import { internalTicketViewSchema } from "@ai-it-support/shared";
import { z } from "zod";
import { errorName, guard, json, methodNotAllowed, repos } from "@/lib/internal/respond";

// Never prerendered: the body reflects the live database.
export const dynamic = "force-dynamic";

// Drops keys the view does not know before the strict check, so a stray column
// can never reach the body. Nested objects stay strict: a stray key there is a 500.
const responseSchema = z.object(internalTicketViewSchema.shape);

const idSchema = z.uuid();

/**
 * Read-only ticket view for the internal tools. Redacted text only: the raw
 * title, raw description and requester data are not selected anywhere.
 * The guard runs before the ID is looked at, so a caller without the token
 * cannot learn whether an ID exists. An uppercase UUID is accepted and
 * lowercased; braces, encoded characters and path tricks are `invalid_id`.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const refusal = await guard(request);
  if (refusal) return refusal;

  const { id } = await context.params;
  if (!idSchema.safeParse(id).success) return json({ error: "invalid_id" }, 400);

  try {
    const view = await repos().getTicketView(id.toLowerCase());
    if (!view) return json({ error: "not_found" }, 404);
    return json(responseSchema.parse(view));
  } catch (error) {
    console.error(`[internal-api] ticket view failed: ${errorName(error)}`);
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
