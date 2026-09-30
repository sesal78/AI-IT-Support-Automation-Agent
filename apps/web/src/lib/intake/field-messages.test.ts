import { ticketSubmissionSchema } from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";
import { ticketIssueMessage } from "./field-messages";

const valid = {
  name: "Jo",
  email: "jo@example.com",
  department: "Finance",
  title: "Laptop will not boot",
  description: "A black screen after the logo.",
  turnstileToken: "token",
};

function messagesFor(input: Record<string, unknown>) {
  const result = ticketSubmissionSchema.safeParse(input, { error: ticketIssueMessage });
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path[0], issue.message]));
}

describe("ticketIssueMessage", () => {
  it("asks for each empty field in plain words", () => {
    expect(
      messagesFor({
        name: " ",
        email: "",
        department: "",
        title: "",
        description: "",
        turnstileToken: "",
      }),
    ).toEqual({
      name: "Enter your name.",
      email: "Enter a valid email address, like name@company.com.",
      department: "Enter your department.",
      title: "Enter a short title.",
      description: "Describe the problem.",
      turnstileToken: "Complete the security check before submitting.",
    });
  });

  it("states the minimum and maximum lengths", () => {
    expect(messagesFor({ ...valid, title: "ab", description: "x".repeat(5001) })).toEqual({
      title: "Title must be at least 3 characters.",
      description: "Description must be at most 5000 characters.",
    });
  });

  it("leaves unknown issues to zod", () => {
    expect(ticketIssueMessage({ code: "invalid_type", path: ["title"] })).toBeUndefined();
    expect(ticketIssueMessage({ code: "too_small", path: ["other"], minimum: 2 })).toBe(
      "This field must be at least 2 characters.",
    );
  });
});
