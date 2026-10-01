import { describe, expect, it } from "vitest";
import { interpretSubmitResponse } from "./submit-result";

const TICKET_ID = "3f0c9a1e-7b2d-4c55-9e1a-2b8f6d4c1a90";

describe("interpretSubmitResponse", () => {
  it("returns the ticket id on 201", () => {
    expect(interpretSubmitResponse(201, { ticketId: TICKET_ID, queued: true })).toEqual({
      kind: "success",
      ticketId: TICKET_ID,
    });
  });

  it("treats a 201 without a ticket id as an error", () => {
    expect(interpretSubmitResponse(201, {})).toMatchObject({ kind: "error" });
    expect(interpretSubmitResponse(201, null)).toMatchObject({ kind: "error" });
  });

  it("maps 400 field errors to the first message per field", () => {
    const result = interpretSubmitResponse(400, {
      error: "invalid_body",
      fieldErrors: { title: ["Too short", "Also bad"], email: ["Invalid email"], junk: "x" },
    });
    expect(result).toEqual({
      kind: "invalid",
      fieldErrors: { title: "Too short", email: "Invalid email" },
      message: expect.stringMatching(/check the highlighted fields/i),
    });
  });

  it("handles a 400 without field errors", () => {
    expect(interpretSubmitResponse(400, { error: "invalid_body" })).toEqual({
      kind: "invalid",
      fieldErrors: {},
      message: expect.any(String),
    });
  });

  it("asks for a new security check on 403", () => {
    const result = interpretSubmitResponse(403, { error: "turnstile_failed" });
    expect(result.kind).toBe("retry");
    expect(result).toMatchObject({ message: expect.stringMatching(/security check/i) });
  });

  it("says too many requests on 429", () => {
    const result = interpretSubmitResponse(429, { error: "rate_limited" });
    expect(result.kind).toBe("retry");
    expect(result).toMatchObject({ message: expect.stringContaining("Too many requests") });
  });

  it("returns a generic error for other statuses", () => {
    expect(interpretSubmitResponse(500, { error: "internal_error" })).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/try again/i),
    });
  });
});
