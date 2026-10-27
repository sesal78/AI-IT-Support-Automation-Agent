import { describe, expect, it } from "vitest";
import { liveSlackEnvShape, parseEnv } from "./env.js";

// Built from pieces so no token-shaped literal sits in the source.
const token = ["xoxb", "test", "0000000000", "fake"].join("-");
const valid = {
  E2E_SLACK_BOT_TOKEN: token,
  E2E_SLACK_CHANNEL_ID: "C0000000001",
  E2E_SLACK_SIGNING_SECRET: "s".repeat(32),
  E2E_SLACK_REVIEWER_ID: "U0REVIEWER1",
};

function message(source: Record<string, string | undefined>): string {
  try {
    parseEnv(liveSlackEnvShape, source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseEnv to throw");
}

describe("liveSlackEnvShape", () => {
  it("parses valid values, and treats every name as optional", () => {
    expect(parseEnv(liveSlackEnvShape, valid)).toEqual(valid);
    expect(parseEnv(liveSlackEnvShape, {})).toEqual({});
    expect(parseEnv(liveSlackEnvShape, { E2E_SLACK_CHANNEL_ID: "" })).toEqual({});
    expect(parseEnv(liveSlackEnvShape, { E2E_SLACK_REVIEWER_ID: "W00000000" })).toEqual({
      E2E_SLACK_REVIEWER_ID: "W00000000",
    });
  });

  it.each([
    ["E2E_SLACK_BOT_TOKEN", ["xoxp", "test", "0000000000"].join("-")],
    ["E2E_SLACK_BOT_TOKEN", ["xoxb", "short"].join("-")],
    ["E2E_SLACK_BOT_TOKEN", ` ${token}`],
    ["E2E_SLACK_CHANNEL_ID", "#itsupport-e2e"],
    ["E2E_SLACK_CHANNEL_ID", "c0000000001"],
    ["E2E_SLACK_CHANNEL_ID", "C000"],
    ["E2E_SLACK_CHANNEL_ID", "C0000000001 "],
    ["E2E_SLACK_CHANNEL_ID", "U0000000001"],
    ["E2E_SLACK_SIGNING_SECRET", "s".repeat(31)],
    ["E2E_SLACK_SIGNING_SECRET", `${"s".repeat(31)}-`],
    ["E2E_SLACK_REVIEWER_ID", "u0000000001"],
    ["E2E_SLACK_REVIEWER_ID", "C0000000001"],
    ["E2E_SLACK_REVIEWER_ID", "U0000000000000"],
  ])("refuses a bad %s, naming it and never quoting the value", (name, value) => {
    const text = message({ ...valid, [name]: value });
    expect(text).toContain(name);
    expect(text).not.toContain(value.trim());
  });
});
