// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TicketForm } from "./ticket-form";

const TICKET_ID = "3f0c9a1e-7b2d-4c55-9e1a-2b8f6d4c1a90";

type RenderOptions = { callback: (token: string) => void; "expired-callback": () => void };
let widget: RenderOptions;
const reset = vi.fn();
const fetchMock = vi.fn();

beforeEach(() => {
  window.turnstile = {
    render: (_el, options) => {
      widget = options as RenderOptions;
      options.callback("token-1");
      return "widget-1";
    },
    reset,
    remove: vi.fn(),
  };
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  reset.mockReset();
  delete window.turnstile;
});

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
}

async function fillAndSubmit(overrides: Record<string, string> = {}) {
  const user = userEvent.setup();
  const values: Record<string, string> = {
    Name: "Jo Tester",
    Email: "jo@example.com",
    Department: "Finance",
    Title: "Laptop will not boot",
    Description: "A black screen after the logo.",
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) {
    if (value) await user.type(screen.getByLabelText(label), value);
  }
  await user.click(screen.getByRole("button", { name: "Submit ticket" }));
  return user;
}

describe("TicketForm", () => {
  it("posts the ticket with the Turnstile token and shows the ticket ID", async () => {
    respond(201, { ticketId: TICKET_ID, queued: true });
    render(<TicketForm siteKey="site-key" />);
    await fillAndSubmit();

    expect(await screen.findByText("Ticket received")).toBeTruthy();
    expect(screen.getByText(TICKET_ID)).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/tickets");
    expect(JSON.parse(init.body)).toMatchObject({
      title: "Laptop will not boot",
      turnstileToken: "token-1",
    });
  });

  it("shows a linked field error for an empty title and sends nothing", async () => {
    render(<TicketForm siteKey="site-key" />);
    await fillAndSubmit({ Title: "" });

    const title = screen.getByLabelText("Title");
    await waitFor(() => expect(title.getAttribute("aria-invalid")).toBe("true"));
    expect(title.getAttribute("aria-describedby")).toBe("title-hint title-error");
    expect(document.getElementById("title-error")?.textContent).toBe("Enter a short title.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps server field errors to fields and gets a new token", async () => {
    respond(400, { error: "invalid_body", fieldErrors: { title: ["Title is not allowed"] } });
    render(<TicketForm siteKey="site-key" />);
    await fillAndSubmit();

    await waitFor(() =>
      expect(document.getElementById("title-error")?.textContent).toBe("Title is not allowed"),
    );
    expect(reset).toHaveBeenCalledWith("widget-1");
  });

  it("shows a banner for a 400 without known fields", async () => {
    respond(400, { error: "invalid_body", fieldErrors: {} });
    render(<TicketForm siteKey="site-key" />);
    await fillAndSubmit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/highlighted fields/);
  });

  it("shows Too many requests on 429", async () => {
    respond(429, { error: "rate_limited" });
    render(<TicketForm siteKey="site-key" />);
    await fillAndSubmit();
    expect((await screen.findByRole("alert")).textContent).toContain("Too many requests");
  });

  it("shows a generic error when the network fails or the body is not JSON", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    render(<TicketForm siteKey="site-key" />);
    const user = await fillAndSubmit();
    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/i);

    // The failed try reset the widget; hand the form a new token and retry.
    act(() => widget.callback("token-2"));
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 502 }));
    await user.click(screen.getByRole("button", { name: "Submit ticket" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole("alert")).textContent).toMatch(/try again/i);
  });

  it("asks for the security check when there is no token", async () => {
    render(<TicketForm siteKey="site-key" />);
    const container = screen.getByTestId("turnstile");
    await waitFor(() => expect(container.getAttribute("data-token-ready")).toBe("true"));
    act(() => widget["expired-callback"]());
    expect(container.getAttribute("data-token-ready")).toBe("false");
    await fillAndSubmit();
    expect(await screen.findByText("Complete the security check before submitting.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
