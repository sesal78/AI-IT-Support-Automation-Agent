"use client";

import { nextHelpdeskStates, type HelpdeskState } from "@ai-it-support/shared";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const selectClass = "w-full rounded-md border border-input bg-background px-3 py-2";

export function StaffActionForms({
  ticketId,
  state,
  assignees,
}: {
  ticketId: string;
  state: HelpdeskState;
  assignees: { id: string; display_name: string }[];
}) {
  const nextStates = nextHelpdeskStates(state);
  return (
    <section aria-labelledby="staff-actions" className="space-y-4 rounded-lg border p-4">
      <h2 id="staff-actions" className="text-lg font-semibold">
        Staff actions
      </h2>
      <ActionForm ticketId={ticketId} kind="note" label="Add note">
        <label className="grid gap-1 text-sm">
          Note
          <Textarea name="body" required rows={3} aria-describedby="staff-note-limit" />
        </label>
        <p id="staff-note-limit" className="text-sm text-muted-foreground">
          Up to 5,000 characters.
        </p>
      </ActionForm>
      <div className="grid gap-4 sm:grid-cols-2">
        {assignees.length > 0 && (
          <ActionForm ticketId={ticketId} kind="assign" label="Assign ticket">
            <label className="grid gap-1 text-sm">
              Assignee
              <select name="assigneeId" defaultValue="" required className={selectClass}>
                <option value="" disabled>
                  Choose a staff member
                </option>
                {assignees.map(({ id, display_name }) => (
                  <option key={id} value={id}>
                    {display_name}
                  </option>
                ))}
              </select>
            </label>
          </ActionForm>
        )}
        {nextStates.length > 0 && (
          <ActionForm ticketId={ticketId} kind="state" label="Change state">
            <label className="grid gap-1 text-sm">
              Next state
              <select key={state} name="toState" defaultValue="" required className={selectClass}>
                <option value="" disabled>
                  Choose a state
                </option>
                {nextStates.map((next) => (
                  <option key={next} value={next}>
                    {next.charAt(0).toUpperCase() + next.slice(1).replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          </ActionForm>
        )}
      </div>
    </section>
  );
}

function ActionForm({
  ticketId,
  kind,
  label,
  children,
}: {
  ticketId: string;
  kind: "note" | "assign" | "state";
  label: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const actionUrl = `/staff/tickets/${ticketId}/actions`;
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setFeedback(null);
    const form = event.currentTarget;
    try {
      const input = { ...Object.fromEntries(new FormData(form)), kind };
      const response = await fetch(actionUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (response.status === 204) {
        form.reset();
        setFeedback({ message: "Change saved", error: false });
        router.refresh();
      } else {
        const output = await response.json().catch(() => null);
        const message =
          typeof output?.message === "string" ? output.message : "Could not save the change";
        setFeedback({ message, error: true });
        if (response.status === 409) router.refresh();
      }
    } catch {
      setFeedback({
        message: "Could not confirm the change. Check the history before trying again.",
        error: true,
      });
      router.refresh();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form aria-label={label} method="post" action={actionUrl} onSubmit={submit}>
      <fieldset disabled={pending} className="space-y-2">
        {children}
        <Button type="submit" variant="outline">
          {label}
        </Button>
      </fieldset>
      {feedback && (
        <p role={feedback.error ? "alert" : "status"} className="mt-2 text-sm">
          {feedback.message}
        </p>
      )}
    </form>
  );
}
