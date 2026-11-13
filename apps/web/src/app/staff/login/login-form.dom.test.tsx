// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sign-in form (P5-T16). It posts to the Route Handler and shows exactly
// one message for bad credentials, so the form never says whether an address
// exists. A 429 names the wait; a 200 sends the user to the guarded landing.
const push = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function reply(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

async function fillAndSubmit() {
  const user = userEvent.setup();
  const { LoginForm } = await import("./login-form");
  render(<LoginForm />);
  await user.type(screen.getByLabelText(/email/i), "agent@example.test");
  await user.type(screen.getByLabelText(/password/i), "a-long-password");
  await user.click(screen.getByRole("button", { name: /sign in/i }));
}

beforeEach(() => {
  push.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LoginForm", () => {
  it("shows the one generic message for bad credentials and stays put", async () => {
    fetchMock.mockImplementation(() => reply(401, { message: "Email or password is wrong" }));
    await fillAndSubmit();

    expect(await screen.findByText("Email or password is wrong")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/staff/login/submit",
      expect.objectContaining({ method: "POST" }),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("names the wait when the sixth attempt is refused", async () => {
    fetchMock.mockImplementation(() =>
      reply(429, { message: "Too many attempts. Try again later." }),
    );
    await fillAndSubmit();

    expect(await screen.findByText(/too many attempts/i)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it("goes to the guarded landing after a good password", async () => {
    fetchMock.mockImplementation(() => reply(200, { ok: true }));
    await fillAndSubmit();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/staff/tickets"));
  });

  it("does not call the route when the form is empty", async () => {
    const user = userEvent.setup();
    const { LoginForm } = await import("./login-form");
    render(<LoginForm />);
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
