// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./login-form", () => ({ LoginForm: () => <form aria-label="staff sign-in" /> }));

describe("/staff/login page", () => {
  it("renders the sign-in screen without requiring a session", async () => {
    const { default: StaffLoginPage } = await import("./page");
    render(StaffLoginPage());
    expect(screen.getByRole("heading", { name: /staff sign in/i })).toBeTruthy();
    expect(screen.getByLabelText("staff sign-in")).toBeTruthy();
  });
});
