import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HELPDESK_SYNC_TASK_ID,
  INTAKE_TICKET_TASK_ID,
  NOTIFICATION_KINDS,
  NOTIFY_REQUESTER_TASK_ID,
  TRIAGE_TICKET_TASK_ID,
  notifyRequesterPayloadSchema,
  ticketNumberSchema,
  ticketSubmissionSchema,
} from "./ticket.js";

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

describe("TRIAGE_TICKET_TASK_ID", () => {
  it("is the Trigger.dev task id of the triage task", () => {
    expect(TRIAGE_TICKET_TASK_ID).toBe("triage-ticket");
  });
});

describe("HELPDESK_SYNC_TASK_ID", () => {
  it("is the Trigger.dev task id of the helpdesk sync task", () => {
    expect(HELPDESK_SYNC_TASK_ID).toBe("helpdesk-sync");
  });
});

describe("ticketNumberSchema", () => {
  it.each(["ITS-000001", "ITS-000042", "ITS-999999"])("accepts %s", (value) => {
    expect(ticketNumberSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    "ITS-1",
    "its-000001",
    "ITS-0000001",
    "ITS-00000a",
    "INC0010001",
    "ITS-000042\r\n",
    "ITS-000042\n",
    " ITS-000042",
    42,
  ])("rejects %j", (value) => {
    expect(ticketNumberSchema.safeParse(value).success).toBe(false);
  });
});

describe("NOTIFY_REQUESTER_TASK_ID and notifyRequesterPayloadSchema", () => {
  const ticketId = "6f1e3c0e-5b8a-4d7e-9c52-0a1b2c3d4e5f";

  it("is the Trigger.dev task id of the requester reply task", () => {
    expect(NOTIFY_REQUESTER_TASK_ID).toBe("notify-requester");
    expect([...NOTIFICATION_KINDS]).toEqual(["incident_reply", "needs_info"]);
  });

  it.each(NOTIFICATION_KINDS)("accepts a ticket id and the kind %s", (kind) => {
    expect(notifyRequesterPayloadSchema.parse({ ticketId, kind })).toEqual({ ticketId, kind });
  });

  it.each([
    ["a non-UUID ticket id", { ticketId: "ITS-000042", kind: "incident_reply" }],
    ["an unknown kind", { ticketId, kind: "welcome" }],
    ["a missing kind", { ticketId }],
    ["an extra key (the requester address)", { ticketId, kind: "needs_info", to: "a@b.test" }],
    ["test overrides", { ticketId, kind: "needs_info", testOverrides: { shadowMode: true } }],
  ])("rejects %s", (_name, payload) => {
    expect(notifyRequesterPayloadSchema.safeParse(payload).success).toBe(false);
  });
});
