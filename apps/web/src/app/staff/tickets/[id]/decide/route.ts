import { createDbClient, createRepositories } from "@ai-it-support/db";
import { TICKET_STATUSES } from "@ai-it-support/shared";
import { wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { env } from "@/env";
import { actionError } from "@/lib/staff/actions";
import { requireStaff, StaffAccessError } from "@/lib/staff/auth";
import { decideStaffReview } from "@/lib/staff/decide";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const ticketBinding = z.strictObject({ status: z.enum(TICKET_STATUSES), is_test: z.boolean() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (env.HELPDESK !== "builtin") return actionError(404, "Ticket not found");
  try {
    const { staff } = await requireStaff("admin", "action");
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin") return actionError(403, "You do not have access");
    if (
      request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
    ) {
      return actionError(400, "Expected a JSON decision");
    }
    const input: unknown = await request.json().catch(() => null);
    const repos = createRepositories(
      createDbClient({
        SUPABASE_URL: env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
        SUPABASE_DB_SCHEMA: env.SUPABASE_DB_SCHEMA,
      }),
    );
    return decideStaffReview(
      {
        async readTicket(id) {
          const client = await createServerSupabaseClient();
          const { data, error } = await client
            .from("tickets")
            .select("status,is_test")
            .eq("id", id)
            .maybeSingle();
          if (error) throw new Error("Could not load staff review ticket");
          return ticketBinding.nullable().parse(data);
        },
        repos,
        readWaitpoint: (id) => wait.retrieveToken(id),
        completeToken: (id, output) => wait.completeToken(id, output),
        e2eMode: env.E2E_MODE,
      },
      staff,
      (await params).id,
      input,
    );
  } catch (error) {
    if (error instanceof StaffAccessError) {
      return actionError(error.status, "You do not have access");
    }
    throw error;
  }
}
