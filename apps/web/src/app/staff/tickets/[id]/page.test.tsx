// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StaffTicketPage from "./page";

const { requireStaff, createServerSupabaseClient, getStaffTicket } = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  getStaffTicket: vi.fn(),
}));

vi.mock("@/lib/staff/auth", () => ({ requireStaff }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient }));
vi.mock("@/lib/staff/ticket-detail-query", () => ({ getStaffTicket }));
vi.mock("@/env", () => ({ env: { E2E_MODE: false } }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
}));

const id = "11111111-1111-4111-8111-000000000001";
const text = "<script>alert(1)</script> javascript:alert(1) مرحبا 🌐";
const record = {
  ticket_number: "ITS-000042",
  redaction: { redacted_title: text, redacted_description: "Description [redacted]" },
  triage: {
    category: "network",
    priority: "P2",
    urgency: "high",
    route: "review",
    probabilities: { routing_confidence: 0.9 },
    sensitive_flags: ["account_security"],
    suggested_fix: { steps: ["Reconnect the VPN"], caveats: ["Requires local access"] },
  },
  helpdesk: { number: "HD0000042", state: "in_progress", assignee: { display_name: "Test agent" } },
  articles: [{ slug: "vpn-setup", title: "VPN setup" }],
  history: [
    { key: "event-1", label: "Review requested", at: "2026-11-19T00:00:00Z" },
    { key: "note-1", label: "Note by Test agent", at: "2026-11-19T00:01:00Z", body: text },
    { key: "assignment-1", label: "Assigned to Test agent", at: "2026-11-19T00:02:00Z" },
  ],
  raw_title: "Private fixture title",
};
const page = (pathId: string) => StaffTicketPage({ params: Promise.resolve({ id: pathId }) });

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("staff ticket detail", () => {
  it("shows permitted fields in a read-only view and renders unsafe-looking text inertly", async () => {
    const client = {};
    createServerSupabaseClient.mockResolvedValue(client);
    getStaffTicket.mockResolvedValue(record);
    const { container } = render(await page(id));

    expect(requireStaff).toHaveBeenCalledBefore(createServerSupabaseClient);
    expect(getStaffTicket).toHaveBeenCalledWith(client, id, false);
    const number = screen.getByRole("heading", { name: "Ticket ITS-000042" });
    const title = screen.getByText(text, { selector: "header p", exact: true });
    expect(number.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const value of [
      "Description [redacted]",
      "network",
      "P2",
      "high",
      "review",
      "90%",
      "account security",
      "VPN setup",
      "vpn-setup",
      "Reconnect the VPN",
      "Requires local access",
      "HD0000042",
      "In progress",
      "Test agent",
    ]) {
      expect(screen.getByText(value, { exact: true })).toBeTruthy();
    }
    expect(container.querySelector("script, a[href^='javascript:'], form")).toBeNull();
    expect(container.textContent).not.toContain("Private fixture title");
    const history = screen.getByRole("region", { name: "History" }).textContent!;
    expect(history.indexOf("Review requested")).toBeLessThan(history.indexOf("Note by Test agent"));
    expect(history.indexOf("Note by Test agent")).toBeLessThan(
      history.indexOf("Assigned to Test agent"),
    );
  });

  it("shows a manual ticket without triage, helpdesk actions or history", async () => {
    getStaffTicket.mockResolvedValue({
      ...record,
      redaction: null,
      triage: null,
      helpdesk: null,
      articles: [],
      history: [],
    });
    render(await page(id));
    expect(screen.getByText("Not in the helpdesk")).toBeTruthy();
    expect(screen.getByText("No triage result")).toBeTruthy();
    expect(screen.getByText("No history yet")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each(["ITS-000042", "junk"])("returns 404 for %s without a database read", async (invalid) => {
    await expect(page(invalid)).rejects.toThrow("404");
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });

  it("returns 404 when no ticket is visible", async () => {
    getStaffTicket.mockResolvedValue(null);
    await expect(page(id)).rejects.toThrow("404");
  });

  it("stops when the staff guard refuses access", async () => {
    requireStaff.mockRejectedValue(new Error("Staff access refused"));
    await expect(page(id)).rejects.toThrow("Staff access refused");
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });
});
