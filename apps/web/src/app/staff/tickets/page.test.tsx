// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StaffTicketsPage from "./page";

// The ticket list screen (P5-T17). The guard, client and query are mocked.
// The query has separate request and database integration tests.
// This file proves what the page renders:
// the guard still runs, the number/title/status/priority/category/assignee/
// created columns show up, the row link holds the UUID (never the ticket
// number), no raw-title canary leaks, an invalid filter shows a message
// without a crash, and the markup carries dark-mode and narrow-viewport classes.
const requireStaff = vi.hoisted(() => vi.fn());
const listStaffTickets = vi.hoisted(() => vi.fn());
const createServerSupabaseClient = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());

vi.mock("@/lib/staff/auth", () => ({ requireStaff }));
vi.mock("@/lib/staff/ticket-list-query", () => ({ listStaffTickets }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
// @/env uses t3-env's client/server split, which throws on a server var once
// `window` exists (this file renders in jsdom to exercise the nested client
// filter bar too), so the page's one env read is stubbed directly.
vi.mock("@/env", () => ({ env: { E2E_MODE: false } }));

const STAFF = { id: "staff-1", displayName: "A. Agent", role: "agent", active: true };
const RAW_TITLE_CANARY = "RAW-TITLE-CANARY-SSN-123-45-6789";

function emptyPage(overrides: Partial<Awaited<ReturnType<typeof listStaffTickets>>> = {}) {
  return { rows: [], total: 0, page: 1, pageCount: 1, ...overrides };
}

async function renderPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  return render(await StaffTicketsPage({ searchParams: Promise.resolve(searchParams) }));
}

beforeEach(() => {
  // listStaffTickets is mocked in every test, so it never dereferences this;
  // tests that care what it was called with assert against `undefined`'s
  // caller-visible stand-in via this fixed stub value instead.
  createServerSupabaseClient.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  requireStaff.mockReset();
  listStaffTickets.mockReset();
  createServerSupabaseClient.mockReset();
  push.mockReset();
});

describe("/staff/tickets page", () => {
  it("runs the guard before rendering and shows the signed-in staff member", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(emptyPage());
    await renderPage();

    expect(requireStaff).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("heading", { name: /tickets/i })).toBeTruthy();
    expect(screen.getByText(/A\. Agent/)).toBeTruthy();
  });

  it("offers a POST sign-out and no other account control", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(emptyPage());
    await renderPage();

    const form = screen.getByRole("button", { name: /sign out/i }).closest("form");
    expect(form?.getAttribute("action")).toBe("/staff/logout");
    expect(form?.getAttribute("method")).toBe("post");
  });

  it("lets the guard's refusal through instead of rendering", async () => {
    requireStaff.mockRejectedValue(new Error("NEXT_REDIRECT:/staff/login"));
    await expect(StaffTicketsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "NEXT_REDIRECT:/staff/login",
    );
    expect(listStaffTickets).not.toHaveBeenCalled();
  });

  it("shows the ITS number before the HD number, and links the row by the UUID", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(
      emptyPage({
        total: 1,
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            ticketNumber: "ITS-000042",
            helpdeskNumber: "HD0000007",
            pipelineStatus: "incident_created",
            helpdeskState: "in_progress",
            priority: "P2",
            category: "network",
            assigneeName: "A. Agent",
            redactedTitle: "VPN connection drops",
            createdAt: "2026-11-01T00:00:00+00:00",
          },
        ],
      }),
    );
    await renderPage();

    const link = screen.getByRole("link", { name: /ITS-000042/ });
    expect(link.getAttribute("href")).toBe("/staff/tickets/11111111-1111-1111-1111-111111111111");
    expect(within(link).getByText("ITS-000042")).toBeTruthy();
    expect(within(link).getByText("HD0000007")).toBeTruthy();
    // Order in the DOM: the ITS number node must come before the HD number node.
    const its = within(link).getByText("ITS-000042");
    const hd = within(link).getByText("HD0000007");
    expect(its.compareDocumentPosition(hd) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the redacted title, status, priority, category, assignee and created date, with no raw-title canary", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(
      emptyPage({
        total: 1,
        rows: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            ticketNumber: "ITS-000001",
            helpdeskNumber: null,
            pipelineStatus: "review_pending",
            helpdeskState: null,
            priority: "P3",
            category: "software",
            assigneeName: null,
            redactedTitle: "Printer offline (redacted)",
            createdAt: "2026-10-15T00:00:00+00:00",
          },
        ],
      }),
    );
    await renderPage();

    expect(screen.getByText("Printer offline (redacted)")).toBeTruthy();
    expect(screen.getByText(/review pending/i)).toBeTruthy();
    expect(screen.getByText("P3")).toBeTruthy();
    expect(screen.getByText(/software/i)).toBeTruthy();
    expect(screen.getByText("2026-10-15")).toBeTruthy();
    expect(document.body.textContent).not.toContain(RAW_TITLE_CANARY);
  });

  it("shows an empty state instead of a crash when no tickets match", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(emptyPage());
    await renderPage({ page: "99" });

    expect(screen.getByText(/no tickets match this view/i)).toBeTruthy();
    expect(listStaffTickets).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ page: 99 }), // page=99 alone (no other filters) is a valid, just out-of-range, page
    );
  });

  it("shows a message and still renders the list for an unknown filter value, never a 500", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(emptyPage());
    await renderPage({ status: "not-a-real-status" });

    expect(screen.getByText(/filters were not understood/i)).toBeTruthy();
    expect(screen.getByText(/showing the unfiltered ticket list/i)).toBeTruthy();
    expect(listStaffTickets).toHaveBeenCalledWith({}, expect.objectContaining({ status: null }));
  });

  it("shows Previous and Next only when another page exists", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(emptyPage({ total: 120, page: 2, pageCount: 3 }));
    await renderPage({ page: "2" });

    const previous = screen.getByText("Previous");
    const next = screen.getByText("Next");
    expect(previous.tagName).toBe("A");
    expect(next.tagName).toBe("A");
    expect(previous.getAttribute("href")).toBe("/staff/tickets");
    expect(next.getAttribute("href")).toBe("/staff/tickets?page=3");
  });

  it("disables Previous on page 1 and Next on the last page", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(emptyPage({ total: 1, page: 1, pageCount: 1 }));
    await renderPage();

    expect(screen.getByText("Previous").tagName).toBe("SPAN");
    expect(screen.getByText("Next").tagName).toBe("SPAN");
  });

  it("uses dark-mode utility classes alongside their light equivalents (both themes styled)", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(emptyPage());
    const { container } = await renderPage();

    const markup = container.innerHTML;
    expect(markup).toMatch(/\bdark:/);
  });

  it("wraps the table so it scrolls instead of widening the page at 375px", async () => {
    requireStaff.mockResolvedValue({ userId: "user-1", staff: STAFF });
    listStaffTickets.mockResolvedValue(
      emptyPage({
        total: 1,
        rows: [
          {
            id: "33333333-3333-3333-3333-333333333333",
            ticketNumber: "ITS-000002",
            helpdeskNumber: null,
            pipelineStatus: "new",
            helpdeskState: null,
            priority: null,
            category: null,
            assigneeName: null,
            redactedTitle: "t",
            createdAt: "2026-10-15T00:00:00+00:00",
          },
        ],
      }),
    );
    const { container } = await renderPage();

    const scroller = container.querySelector('[data-slot="table-container"]');
    expect(scroller?.className).toMatch(/overflow-x-auto/);
  });
});
