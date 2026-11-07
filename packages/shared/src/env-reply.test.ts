import { describe, expect, it } from "vitest";
import { parseEnv, replyEnvShape } from "./env.js";

// Built from pieces so no key-shaped literal sits in the source.
const key = ["re", "0123456789abcdefghij"].join("_");
const valid = {
  RESEND_API_KEY: key,
  REPLY_FROM: "help@example.com",
  REPLY_ALLOWED_RECIPIENTS: "a@example.com,b@example.com",
};

function message(source: Record<string, string>): string {
  try {
    parseEnv(replyEnvShape, source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseEnv to throw");
}

describe("replyEnvShape", () => {
  it("parses valid values and splits the recipients", () => {
    expect(parseEnv(replyEnvShape, valid)).toEqual({
      ...valid,
      REPLY_ALLOWED_RECIPIENTS: ["a@example.com", "b@example.com"],
    });
  });

  it.each([
    ["RESEND_API_KEY", "x".repeat(24)],
    ["RESEND_API_KEY", "re_short"],
    ["REPLY_FROM", "help@example.com,other@example.com"],
    ["REPLY_FROM", "Help <help@example.com>"],
    ["REPLY_FROM", "Help@Example.com"],
    ["REPLY_FROM", "..@example.com"],
    ["REPLY_FROM", ".a@example.com"],
    ["REPLY_FROM", "a.@example.com"],
    ["REPLY_FROM", "a@-example.com"],
    ["REPLY_ALLOWED_RECIPIENTS", "A@example.com"],
    ["REPLY_ALLOWED_RECIPIENTS", "a@example.com,a@example.com"],
    ["REPLY_ALLOWED_RECIPIENTS", "a@example.com, b@example.com"],
    ["REPLY_ALLOWED_RECIPIENTS", ""],
    [
      "REPLY_ALLOWED_RECIPIENTS",
      Array.from({ length: 21 }, (_, i) => `u${i}@example.com`).join(","),
    ],
  ])("fails %s for %j, naming the variable", (name, value) => {
    expect(message({ ...valid, [name]: value })).toContain(name);
  });

  it("accepts 20 recipients", () => {
    const list = Array.from({ length: 20 }, (_, i) => `u${i}@example.com`);
    const parsed = parseEnv(replyEnvShape, { ...valid, REPLY_ALLOWED_RECIPIENTS: list.join(",") });
    expect(parsed.REPLY_ALLOWED_RECIPIENTS).toEqual(list);
  });

  it("never echoes the key", () => {
    expect(message({ ...valid, RESEND_API_KEY: `${key} bad` })).not.toContain(key);
  });
});
