import { internalUsageSchema } from "@ai-it-support/shared";
import { errorName, guard, json, methodNotAllowed, repos } from "@/lib/internal/respond";

// Never prerendered: the body reflects the live database.
export const dynamic = "force-dynamic";

/**
 * AI usage of one UTC month. The guard runs before the query is read.
 * `month` must appear exactly once as `YYYY-MM` (01-12); other parameters are
 * ignored. The month may lie in the future: it returns zeros.
 */
export async function GET(request: Request) {
  const refusal = await guard(request);
  if (refusal) return refusal;

  const months = new URL(request.url).searchParams.getAll("month");
  const month = months.length === 1 ? months[0] : undefined;
  if (month === undefined || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return json({ error: "invalid_month" }, 400);
  }

  try {
    const { llm, typesafe } = await repos().getAiUsage(`${month}-01`);
    return json(internalUsageSchema.parse({ month, llm, typesafe }));
  } catch (error) {
    console.error(`[internal-api] usage failed: ${errorName(error)}`);
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
