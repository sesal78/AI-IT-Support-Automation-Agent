import { describe, expect, it } from "vitest";
import { evalTicketSchema } from "./eval-ticket.js";

const valid = {
  id: "E001",
  set: "normal",
  name: "Jo Bloggs",
  email: "jo.bloggs@example.com",
  department: "Finance",
  title: "Laptop will not boot",
  description: "It shows a black screen after the logo.",
  expected: {
    category: "hardware",
    priority: "P3",
    assignmentGroup: "Hardware",
    flags: [],
    route: null,
    sensitiveTopic: null,
  },
};

/** The dotted paths of every issue the schema reports for `input`. */
function issuePaths(input: unknown): string[] {
  const result = evalTicketSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("evalTicketSchema", () => {
  it("accepts a valid ticket", () => {
    expect(evalTicketSchema.parse(valid)).toEqual(valid);
  });

  it("accepts an injection ticket with forbidden phrases and a topic", () => {
    const ticket = {
      ...valid,
      set: "injection",
      expected: {
        ...valid.expected,
        flags: ["injection_suspected"],
        route: "review",
        sensitiveTopic: "executive",
        forbiddenPhrases: ["access granted"],
      },
    };
    expect(evalTicketSchema.parse(ticket)).toEqual(ticket);
  });

  it("rejects an unknown set, naming the field", () => {
    expect(issuePaths({ ...valid, set: "weird" })).toContain("set");
  });

  it("rejects a missing expected.priority, naming the field", () => {
    const expected: Record<string, unknown> = { ...valid.expected };
    delete expected.priority;
    expect(issuePaths({ ...valid, expected })).toContain("expected.priority");
  });

  it("rejects a duplicate flag, naming the field", () => {
    const expected = { ...valid.expected, flags: ["needs_info", "needs_info"] };
    expect(issuePaths({ ...valid, expected })).toContain("expected.flags");
  });

  it.each([
    ["id", "e1"],
    ["email", "not-an-email"],
    ["title", "ab"],
    ["description", "short"],
    ["name", ""],
  ])("rejects a bad %s", (field, value) => {
    expect(issuePaths({ ...valid, [field]: value })).toContain(field);
  });

  it.each([
    ["category", "printer"],
    ["priority", "P0"],
    ["assignmentGroup", "Helpdesk"],
    ["route", "auto"],
    ["sensitiveTopic", "finance"],
  ])("rejects a bad expected.%s", (field, value) => {
    expect(issuePaths({ ...valid, expected: { ...valid.expected, [field]: value } })).toContain(
      `expected.${field}`,
    );
  });

  it("rejects an unknown key and a blank forbidden phrase", () => {
    expect(evalTicketSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
    const expected = { ...valid.expected, forbiddenPhrases: ["  "] };
    expect(issuePaths({ ...valid, expected })).toContain("expected.forbiddenPhrases.0");
  });
});
