import { EVAL_SENSITIVE_TOPICS } from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";
import { SENSITIVE_TOPICS } from "./topics.js";

describe("SENSITIVE_TOPICS", () => {
  it("equals EVAL_SENSITIVE_TOPICS in @ai-it-support/shared, in order", () => {
    expect([...SENSITIVE_TOPICS]).toEqual([...EVAL_SENSITIVE_TOPICS]);
  });
});
