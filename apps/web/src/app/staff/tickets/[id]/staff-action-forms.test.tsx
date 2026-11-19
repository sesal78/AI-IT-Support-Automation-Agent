// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StaffActionForms } from "./staff-action-forms";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const ticketId = "11111111-1111-4111-8111-000000000011";
const staff = [{ id: "11111111-1111-4111-8111-000000000022", display_name: "Test agent" }];

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

it("offers the active staff and only the moves allowed from the current state", () => {
  const view = render(
    <StaffActionForms ticketId={ticketId} state="in_progress" assignees={staff} />,
  );
  const assignee = screen.getByLabelText("Assignee", { selector: "select" });
  expect(
    within(assignee)
      .getAllByRole("option")
      .map((opt) => opt.textContent),
  ).toEqual(["Choose a staff member", "Test agent"]);
  const state = screen.getByLabelText("Next state");
  expect(
    within(state)
      .getAllByRole("option")
      .map((opt) => opt.textContent),
  ).toEqual(["Choose a state", "On hold", "Resolved"]);
  view.rerender(<StaffActionForms ticketId={ticketId} state="closed" assignees={staff} />);
  expect(screen.queryByLabelText("Next state")).toBeNull();
});

it("submits once while a note is in flight, then refreshes the detail page", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<StaffActionForms ticketId={ticketId} state="new" assignees={staff} />);
  const form = screen.getByRole("form", { name: "Add note" });
  expect(form.getAttribute("method")).toBe("post");
  fireEvent.change(screen.getByLabelText("Note"), { target: { value: "Check again" } });
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    `/staff/tickets/${ticketId}/actions`,
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ body: "Check again", kind: "note" }),
    }),
  );
  finish(new Response(null, { status: 204 }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("Note")).toHaveProperty("value", "");
});

it("shows the refusal and refreshes an out-of-date state", async () => {
  const message = "That change is not allowed from on hold; the page was refreshed";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message }, { status: 409 })));
  render(<StaffActionForms ticketId={ticketId} state="new" assignees={staff} />);
  fireEvent.change(screen.getByLabelText("Next state"), { target: { value: "closed" } });
  fireEvent.submit(screen.getByRole("form", { name: "Change state" }));
  expect((await screen.findByRole("alert")).textContent).toBe(message);
  expect(refresh).toHaveBeenCalledOnce();
});
