// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The guarded landing (P5-T16). The ticket list itself is B10; this page only
// proves the guard runs and the signed-in staff member is shown.
const requireStaff = vi.hoisted(() => vi.fn());

vi.mock("@/lib/staff/auth", () => ({ requireStaff }));

afterEach(() => {
  cleanup();
});

describe("/staff/tickets page", () => {
  it("shows the signed-in staff member", async () => {
    requireStaff.mockResolvedValue({
      userId: "user-1",
      staff: { id: "staff-1", displayName: "A. Agent", role: "agent", active: true },
    });
    const { default: StaffTicketsPage } = await import("./page");
    render(await StaffTicketsPage());

    expect(screen.getByRole("heading", { name: /tickets/i })).toBeTruthy();
    expect(screen.getByText(/A\. Agent/)).toBeTruthy();
    expect(requireStaff).toHaveBeenCalledTimes(1);
  });

  it("offers a POST sign-out and no other account control", async () => {
    requireStaff.mockResolvedValue({
      userId: "user-1",
      staff: { id: "staff-1", displayName: "A. Agent", role: "agent", active: true },
    });
    const { default: StaffTicketsPage } = await import("./page");
    render(await StaffTicketsPage());

    const form = screen.getByRole("button", { name: /sign out/i }).closest("form");
    expect(form?.getAttribute("action")).toBe("/staff/logout");
    expect(form?.getAttribute("method")).toBe("post");
  });

  it("lets the guard's refusal through instead of rendering", async () => {
    requireStaff.mockRejectedValue(new Error("NEXT_REDIRECT:/staff/login"));
    const { default: StaffTicketsPage } = await import("./page");
    await expect(StaffTicketsPage()).rejects.toThrow("NEXT_REDIRECT:/staff/login");
  });
});
