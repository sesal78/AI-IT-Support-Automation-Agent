import { beforeEach, expect, it, vi } from "vitest";
import { StaffAccessError } from "@/lib/staff/auth";
import { POST } from "./route";

const { env, requireStaff, createDbClient, decideStaffReview } = vi.hoisted(() => ({
  env: { HELPDESK: "builtin", E2E_MODE: false },
  requireStaff: vi.fn(),
  createDbClient: vi.fn(),
  decideStaffReview: vi.fn(),
}));
vi.mock("@/env", () => ({ env }));
vi.mock("@/lib/staff/auth", async (original) => ({
  ...(await original<typeof import("@/lib/staff/auth")>()),
  requireStaff,
}));
vi.mock("@ai-it-support/db", () => ({ createDbClient, createRepositories: () => ({}) }));
vi.mock("@trigger.dev/sdk", () => ({ wait: { completeToken: vi.fn() } }));
vi.mock("@/lib/staff/decide", () => ({ decideStaffReview }));

const id = "11111111-1111-4111-8111-111111111111";
const staff = { id, role: "admin", active: true };

beforeEach(() => {
  vi.clearAllMocks();
  env.HELPDESK = "builtin";
  requireStaff.mockResolvedValue({ staff });
  decideStaffReview.mockResolvedValue(Response.json({ outcome: "recorded" }));
});

function post(headers: HeadersInit = { "content-type": "application/json" }) {
  return POST(
    new Request(`https://example.test/staff/tickets/${id}/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({ decision: "approve" }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

it.each([
  [401, "no_user"],
  [403, "wrong_role"],
] as const)("returns %i without creating the service client", async (status, reason) => {
  requireStaff.mockRejectedValue(new StaffAccessError(status, reason));
  expect((await post()).status).toBe(status);
  expect(requireStaff).toHaveBeenCalledWith("admin", "action");
  expect(createDbClient).not.toHaveBeenCalled();
  expect(decideStaffReview).not.toHaveBeenCalled();
});

it("returns 404 in ServiceNow mode before reading the session", async () => {
  env.HELPDESK = "servicenow";
  expect((await post()).status).toBe(404);
  expect(requireStaff).not.toHaveBeenCalled();
});

it.each([
  [{ "content-type": "application/json", "sec-fetch-site": "cross-site" }, 403],
  [{ "content-type": "text/plain" }, 400],
] as const)(
  "rejects an unsafe POST before creating the service client",
  async (headers, status) => {
    expect((await post(headers)).status).toBe(status);
    expect(createDbClient).not.toHaveBeenCalled();
  },
);

it("uses only the guarded admin identity for a valid POST", async () => {
  const response = await post({
    "content-type": "application/json; charset=utf-8",
    "sec-fetch-site": "same-origin",
  });
  expect(await response.json()).toEqual({ outcome: "recorded" });
  expect(decideStaffReview).toHaveBeenCalledWith(
    expect.objectContaining({ e2eMode: false }),
    staff,
    id,
    { decision: "approve" },
  );
});
