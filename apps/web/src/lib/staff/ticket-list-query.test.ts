import { createServerClient } from "@supabase/ssr";
import { afterEach, expect, it, vi } from "vitest";
import { parseTicketListQuery } from "./ticket-list-filters";
import { listStaffTickets } from "./ticket-list-query";

const supabase = createServerClient("http://127.0.0.1:54321", "test-anon-key", {
  db: { schema: "itsupport" },
  cookies: { getAll: () => [], setAll: () => {} },
});
const { filters } = parseTicketListQuery({ page: "2" }, { e2eMode: false });

afterEach(() => vi.unstubAllGlobals());

it("requests only the current page and permitted fields", async () => {
  const request = vi.fn(async (_input: string) =>
    Response.json([], { headers: { "content-range": "*/0" } }),
  );
  vi.stubGlobal("fetch", request);
  await listStaffTickets(supabase, filters);
  expect(request).toHaveBeenCalledTimes(1);
  const url = new URL(request.mock.calls[0]![0]);
  expect(url.pathname).toBe("/rest/v1/tickets");
  expect(url.searchParams.get("offset")).toBe("50");
  expect(url.searchParams.get("limit")).toBe("50");
  expect(url.searchParams.get("order")).toBe("created_at.desc,id.asc");
  expect(url.searchParams.get("is_test")).toBe("eq.false");
  expect(url.searchParams.get("select")).not.toMatch(
    /\*|raw_title|raw_description|requester_email|requester_name|idempotency_key/,
  );
});

it("refuses malformed database rows with a fixed error", async () => {
  vi.stubGlobal("fetch", async () =>
    Response.json([{ unexpected: true }], { headers: { "content-range": "0-0/1" } }),
  );
  await expect(listStaffTickets(supabase, filters)).rejects.toThrow("Unexpected staff ticket data");
});
