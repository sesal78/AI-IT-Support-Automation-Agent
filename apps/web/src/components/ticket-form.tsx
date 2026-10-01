"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ticketSubmissionSchema, type TicketSubmission } from "@ai-it-support/shared";
import { CircleAlert, CircleCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { useForm, type FieldPath } from "react-hook-form";
import { TurnstileWidget } from "@/components/turnstile-widget";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ticketIssueMessage } from "@/lib/intake/field-messages";
import { interpretSubmitResponse, type SubmitOutcome } from "@/lib/intake/submit-result";

type FormField = Exclude<FieldPath<TicketSubmission>, "turnstileToken">;

const textFields: Array<{
  name: FormField;
  label: string;
  type?: string;
  autoComplete?: string;
  hint?: string;
}> = [
  { name: "name", label: "Name", autoComplete: "name" },
  { name: "email", label: "Email", type: "email", autoComplete: "email" },
  { name: "department", label: "Department", autoComplete: "organization-title" },
  { name: "title", label: "Title", hint: "One line, e.g. “Laptop will not boot”." },
];

const formFields = new Set<string>(["name", "email", "department", "title", "description"]);

async function postTicket(values: TicketSubmission): Promise<SubmitOutcome> {
  try {
    const res = await fetch("/api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    const body: unknown = await res.json().catch(() => null);
    return interpretSubmitResponse(res.status, body);
  } catch {
    return interpretSubmitResponse(0, null);
  }
}

export function TicketForm({ siteKey }: { siteKey: string }) {
  const [ticketId, setTicketId] = useState<string | undefined>();
  const [banner, setBanner] = useState<string | undefined>();
  const [resetSignal, setResetSignal] = useState(0);

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting, isSubmitted },
  } = useForm<TicketSubmission>({
    resolver: zodResolver(ticketSubmissionSchema, { error: ticketIssueMessage }),
    defaultValues: {
      name: "",
      email: "",
      department: "",
      title: "",
      description: "",
      turnstileToken: "",
    },
  });

  const onToken = useCallback(
    (token: string) => setValue("turnstileToken", token, { shouldValidate: isSubmitted }),
    [setValue, isSubmitted],
  );

  const onSubmit = handleSubmit(async (values) => {
    setBanner(undefined);
    const outcome = await postTicket(values);
    if (outcome.kind === "success") {
      setTicketId(outcome.ticketId);
      return;
    }
    // Turnstile tokens are single use: get a fresh one before the next try.
    setValue("turnstileToken", "");
    setResetSignal((n) => n + 1);
    if (outcome.kind === "invalid") {
      const fields = Object.entries(outcome.fieldErrors).filter(([field]) => formFields.has(field));
      for (const [field, message] of fields) {
        setError(field as FormField, { type: "server", message });
      }
      if (fields.length === 0) setBanner(outcome.message);
      return;
    }
    setBanner(outcome.message);
  });

  if (ticketId) {
    return (
      <div role="status" className="flex flex-col items-start gap-3 py-2">
        <CircleCheck aria-hidden className="size-8 text-emerald-600 dark:text-emerald-400" />
        <h2 className="text-xl font-semibold tracking-tight">Ticket received</h2>
        <p className="text-sm text-muted-foreground">
          The IT team has your request. Quote this ticket ID if you contact them about it:
        </p>
        <p className="w-full rounded-lg border border-dashed bg-muted/50 px-3 py-2 font-mono text-sm break-all">
          {ticketId}
        </p>
      </div>
    );
  }

  const describedBy = (field: string, hint?: boolean) =>
    [hint ? `${field}-hint` : undefined, errors[field as FormField] ? `${field}-error` : undefined]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <form onSubmit={onSubmit} noValidate aria-label="New IT support ticket">
      <FieldGroup>
        {banner ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertTitle>Your ticket was not sent</AlertTitle>
            <AlertDescription>{banner}</AlertDescription>
          </Alert>
        ) : null}

        {textFields.map(({ name, label, type, autoComplete, hint }) => (
          <Field key={name} data-invalid={errors[name] ? true : undefined}>
            <FieldLabel htmlFor={name}>{label}</FieldLabel>
            <Input
              id={name}
              type={type ?? "text"}
              autoComplete={autoComplete}
              aria-invalid={errors[name] ? true : undefined}
              aria-describedby={describedBy(name, Boolean(hint))}
              {...register(name)}
            />
            {hint ? <FieldDescription id={`${name}-hint`}>{hint}</FieldDescription> : null}
            <FieldError id={`${name}-error`}>{errors[name]?.message}</FieldError>
          </Field>
        ))}

        <Field data-invalid={errors.description ? true : undefined}>
          <FieldLabel htmlFor="description">Description</FieldLabel>
          <Textarea
            id="description"
            rows={5}
            className="min-h-32"
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={describedBy("description", true)}
            {...register("description")}
          />
          <FieldDescription id="description-hint">
            What happened, what you expected, and any error text. Do not include passwords.
          </FieldDescription>
          <FieldError id="description-error">{errors.description?.message}</FieldError>
        </Field>

        <Field data-invalid={errors.turnstileToken ? true : undefined}>
          <input type="hidden" {...register("turnstileToken")} />
          <TurnstileWidget
            siteKey={siteKey}
            onToken={onToken}
            resetSignal={resetSignal}
            describedById={errors.turnstileToken ? "turnstile-error" : undefined}
          />
          <FieldError id="turnstile-error">{errors.turnstileToken?.message}</FieldError>
        </Field>

        <Button type="submit" size="lg" disabled={isSubmitting} className="w-full sm:w-auto">
          {isSubmitting ? "Sending…" : "Submit ticket"}
        </Button>
      </FieldGroup>
    </form>
  );
}
