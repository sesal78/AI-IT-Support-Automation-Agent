import { describe, expect, it } from "vitest";
import { z } from "zod";
import { INTAKE_TICKET_TASK_ID, ticketSubmissionSchema } from "./ticket.js";

const valid = {
  name: "Jo Bloggs",
  email: "jo@example.com",
  department: "Finance",
  title: "Laptop will not boot",
  description: "It shows a black screen after the logo.",
  turnstileToken: "token-from-widget",
};

function fieldErrors(input: unknown) {
  const result = ticketSubmissionSchema.safeParse(input);
  if (result.success) return {};
  return z.flattenError(result.error).fieldErrors as Record<string, string[] | undefined>;
}

describe("ticketSubmissionSchema", () => {
  it("accepts a valid submission", () => {
    expect(ticketSubmissionSchema.parse(valid)).toEqual(valid);
  });

  it("trims surrounding whitespace", () => {
    expect(ticketSubmissionSchema.parse({ ...valid, name: "  Jo  " }).name).toBe("Jo");
  });

  it.each([
    ["name", "", "x".repeat(100), "x".repeat(101)],
    ["department", "", "x".repeat(100), "x".repeat(101)],
    ["title", "ab", "x".repeat(200), "x".repeat(201)],
    ["description", "x".repeat(9), "x".repeat(5000), "x".repeat(5001)],
  ])("enforces the length limits of %s", (field, tooShort, longest, tooLong) => {
    expect(fieldErrors({ ...valid, [field]: tooShort })[field]).toBeDefined();
    expect(fieldErrors({ ...valid, [field]: longest })[field]).toBeUndefined();
    expect(fieldErrors({ ...valid, [field]: tooLong })[field]).toBeDefined();
  });

  it("rejects a whitespace-only name", () => {
    expect(fieldErrors({ ...valid, name: "   " }).name).toBeDefined();
  });

  it("rejects an invalid email", () => {
    expect(fieldErrors({ ...valid, email: "not-an-email" }).email).toBeDefined();
  });

  it("requires turnstileToken", () => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest.turnstileToken;
    expect(fieldErrors(rest).turnstileToken).toBeDefined();
    expect(fieldErrors({ ...valid, turnstileToken: "" }).turnstileToken).toBeDefined();
  });

  it("does not echo field values in its error messages", () => {
    const secretish = "short";
    const result = ticketSubmissionSchema.safeParse({ ...valid, description: secretish });
    expect(result.success).toBe(false);
    expect(JSON.stringify(z.flattenError(result.error!))).not.toContain(secretish);
  });
});

describe("INTAKE_TICKET_TASK_ID", () => {
  it("is the Trigger.dev task id of the intake task", () => {
    expect(INTAKE_TICKET_TASK_ID).toBe("intake-ticket");
  });
});
