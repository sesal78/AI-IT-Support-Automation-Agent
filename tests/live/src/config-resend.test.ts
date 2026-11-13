import { describe, expect, it } from "vitest";
import { loadLiveConfig, missingResendEnv } from "./config.ts";
import { markerEnv } from "./testing/env.ts";

// Built from pieces so no key-shaped literal sits in the source.
const READ_KEY = ["re", `MarkerReadKey${"d".repeat(20)}`].join("_");
const RECIPIENT = "reply.mailbox@example.com";
const base = markerEnv("https://e2e.example.com");

describe("loadLiveConfig reply-email variables", () => {
  it("reads the two variables, with both added to the leak-check secrets", () => {
    const config = loadLiveConfig({
      ...base,
      E2E_RESEND_READ_KEY: READ_KEY,
      E2E_REPLY_RECIPIENT: RECIPIENT,
    });
    expect(config.resend).toEqual({ readKey: READ_KEY, replyRecipient: RECIPIENT });
    expect(config.secrets).toContain(READ_KEY);
    expect(config.secrets).toContain(RECIPIENT);
    expect(missingResendEnv(config)).toEqual([]);
  });

  it("with the names unset the config loads and every name is missing", () => {
    const config = loadLiveConfig({ ...base, E2E_RESEND_READ_KEY: "", E2E_REPLY_RECIPIENT: "" });
    expect(config.resend).toEqual({ readKey: undefined, replyRecipient: undefined });
    expect(missingResendEnv(config)).toEqual(["E2E_RESEND_READ_KEY", "E2E_REPLY_RECIPIENT"]);
  });

  it.each([
    ["E2E_RESEND_READ_KEY", "x".repeat(24)],
    ["E2E_RESEND_READ_KEY", "re_short"],
    ["E2E_REPLY_RECIPIENT", "Reply.Mailbox@example.com"],
    ["E2E_REPLY_RECIPIENT", "Reply <reply.mailbox@example.com>"],
    ["E2E_REPLY_RECIPIENT", "reply.mailbox@example.com,other@example.com"],
  ])("a bad %s fails, naming the variable and not quoting the value", (name, value) => {
    const bad = { ...base, [name]: value };
    expect(() => loadLiveConfig(bad)).toThrow(new RegExp(name));
    try {
      loadLiveConfig(bad);
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });

  it("names only the unset variable when one of the two is given", () => {
    const config = loadLiveConfig({ ...base, E2E_RESEND_READ_KEY: READ_KEY });
    expect(missingResendEnv(config)).toEqual(["E2E_REPLY_RECIPIENT"]);
  });
});
