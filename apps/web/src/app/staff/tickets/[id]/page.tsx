import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { env } from "@/env";
import { requireStaff } from "@/lib/staff/auth";
import { getStaffTicket, listActiveStaff } from "@/lib/staff/ticket-detail-query";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { StaffActionForms } from "./staff-action-forms";
import { StaffReviewControls } from "./staff-review-controls";

const timestamp = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Australia/Melbourne",
});
const percent = new Intl.NumberFormat("en-AU", {
  style: "percent",
  maximumFractionDigits: 1,
});

export default async function StaffTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { staff } = await requireStaff();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const client = await createServerSupabaseClient();
  const record = await getStaffTicket(client, id, env.E2E_MODE);
  if (!record) notFound();
  const { redaction, triage, helpdesk, articles, history } = record;
  const fix = triage?.suggested_fix;
  const assignees = helpdesk ? await listActiveStaff(client) : [];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10">
      <header className="space-y-3">
        <Link href="/staff/tickets" className="text-sm text-muted-foreground underline">
          Back to tickets
        </Link>
        <h1 className="font-mono text-sm font-semibold text-muted-foreground">
          Ticket {record.ticket_number}
        </h1>
        <p dir="auto" className="text-3xl font-semibold tracking-tight wrap-anywhere">
          {redaction?.redacted_title ?? "Redacted title unavailable"}
        </p>
      </header>

      <section aria-labelledby="ticket-description" className="space-y-2">
        <h2 id="ticket-description" className="text-lg font-semibold">
          Description
        </h2>
        <p dir="auto" className="wrap-anywhere whitespace-pre-wrap">
          {redaction?.redacted_description ?? "Redacted description unavailable"}
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
        <section
          aria-labelledby="ticket-triage"
          className="min-w-0 space-y-3 rounded-lg border p-4"
        >
          <h2 id="ticket-triage" className="text-lg font-semibold">
            Triage
          </h2>
          {triage ? (
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label="Category">{triage.category}</Field>
              <Field label="Priority">{triage.priority}</Field>
              <Field label="Urgency">{triage.urgency}</Field>
              <Field label="Route">{triage.route}</Field>
              <Field label="Sensitive flags">
                {triage.sensitive_flags.map(words).join(", ") || "None"}
              </Field>
              <Field label="Probabilities">
                <ul>
                  {Object.entries(triage.probabilities ?? {}).map(([name, value]) => (
                    <li key={name}>
                      {words(name)} <span>{percent.format(value)}</span>
                    </li>
                  ))}
                </ul>
              </Field>
            </dl>
          ) : (
            <p>No triage result</p>
          )}
        </section>

        <section
          aria-labelledby="ticket-helpdesk"
          className="min-w-0 space-y-3 rounded-lg border p-4"
        >
          <h2 id="ticket-helpdesk" className="text-lg font-semibold">
            Helpdesk
          </h2>
          {helpdesk ? (
            <dl className="grid gap-3">
              <Field label="Helpdesk number">{helpdesk.number}</Field>
              <Field label="State">{capitalize(words(helpdesk.state))}</Field>
              <Field label="Assignee">{helpdesk.assignee?.display_name ?? "Unassigned"}</Field>
            </dl>
          ) : (
            <p>Not in the helpdesk</p>
          )}
        </section>
      </div>

      {articles.length > 0 && (
        <section aria-labelledby="ticket-articles" className="space-y-2">
          <h2 id="ticket-articles" className="text-lg font-semibold">
            Knowledge base
          </h2>
          <ul className="space-y-1">
            {articles.map(({ slug, title }) => (
              <li key={slug} dir="auto" className="wrap-anywhere">
                {title} <span className="text-sm text-muted-foreground">{slug}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {fix && (
        <section aria-labelledby="ticket-fix" className="space-y-2">
          <h2 id="ticket-fix" className="text-lg font-semibold">
            Suggested fix
          </h2>
          <ol className="list-decimal space-y-1 ps-5">
            {fix.steps.map((step, index) => (
              <li key={index} dir="auto" className="wrap-anywhere whitespace-pre-wrap">
                {step}
              </li>
            ))}
          </ol>
          {fix.caveats?.map((caveat, index) => (
            <p
              key={index}
              dir="auto"
              className="wrap-anywhere whitespace-pre-wrap text-muted-foreground"
            >
              {caveat}
            </p>
          ))}
        </section>
      )}

      {record.waitingForReview && (
        <section aria-labelledby="ticket-review" className="space-y-3 rounded-lg border p-4">
          <h2 id="ticket-review" className="text-lg font-semibold">
            Waiting for review
          </h2>
          {staff.role === "admin" && <StaffReviewControls ticketId={id} />}
        </section>
      )}

      {helpdesk && <StaffActionForms ticketId={id} state={helpdesk.state} assignees={assignees} />}

      <section aria-labelledby="ticket-history" className="space-y-2">
        <h2 id="ticket-history" className="text-lg font-semibold">
          History
        </h2>
        {history.length > 0 ? (
          <ol className="divide-y rounded-lg border px-4">
            {history.map(({ key, label, body, at }) => (
              <li key={key} className="space-y-1 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                  <p dir="auto" className="font-medium wrap-anywhere">
                    {label}
                  </p>
                  <time dateTime={at} className="text-sm text-muted-foreground">
                    {timestamp.format(new Date(at))}
                  </time>
                </div>
                {body && (
                  <p dir="auto" className="wrap-anywhere whitespace-pre-wrap">
                    {body}
                  </p>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p>No history yet</p>
        )}
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd dir="auto" className="wrap-anywhere">
        {children ?? "Unavailable"}
      </dd>
    </div>
  );
}

function words(value: string) {
  return value.replaceAll("_", " ");
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
