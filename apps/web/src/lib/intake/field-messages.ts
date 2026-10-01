/** The parts of a zod issue that the ticket form's messages depend on. */
export interface TicketIssue {
  code: string;
  path?: PropertyKey[];
  input?: unknown;
  minimum?: number | bigint;
  maximum?: number | bigint;
}

const labels: Record<string, string> = {
  name: "Name",
  email: "Email",
  department: "Department",
  title: "Title",
  description: "Description",
};

const emptyMessages: Record<string, string> = {
  name: "Enter your name.",
  department: "Enter your department.",
  title: "Enter a short title.",
  description: "Describe the problem.",
};

/**
 * Plain-language messages for the shared ticket schema, passed to zod as an
 * error map by the form. The schema itself stays in packages/shared.
 */
export function ticketIssueMessage(issue: TicketIssue): string | undefined {
  const field = String(issue.path?.[0] ?? "");
  if (field === "turnstileToken") return "Complete the security check before submitting.";
  if (field === "email") return "Enter a valid email address, like name@company.com.";

  const label = labels[field] ?? "This field";
  if (issue.code === "too_small") {
    const empty = typeof issue.input === "string" && issue.input.trim() === "";
    if (empty && emptyMessages[field]) return emptyMessages[field];
    return `${label} must be at least ${issue.minimum} characters.`;
  }
  if (issue.code === "too_big") return `${label} must be at most ${issue.maximum} characters.`;
  return undefined;
}
