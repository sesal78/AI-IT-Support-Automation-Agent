import { describe, expect, it } from "vitest";
import { loadLiveConfig, LiveConfigError, missingSlackEnv } from "./config.ts";
import { markerEnv, markerSlackEnv } from "./testing/env.ts";

const env = { ...markerEnv("https://e2e.example.com"), ...markerSlackEnv() };

function failure(source: Record<string, string | undefined>): LiveConfigError {
  try {
    loadLiveConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(LiveConfigError);
    return error as LiveConfigError;
  }
  throw new Error("expected loadLiveConfig to throw");
}

describe("loadLiveConfig Slack variables", () => {
  it("reads the four names, and counts the token and signing secret as secrets", () => {
    const config = loadLiveConfig(env);
    expect(config.slack).toEqual({
      botToken: env.E2E_SLACK_BOT_TOKEN,
      channelId: env.E2E_SLACK_CHANNEL_ID,
      signingSecret: env.E2E_SLACK_SIGNING_SECRET,
      reviewerId: env.E2E_SLACK_REVIEWER_ID,
    });
    expect(config.secrets).toEqual(
      expect.arrayContaining([env.E2E_SLACK_BOT_TOKEN, env.E2E_SLACK_SIGNING_SECRET]),
    );
    expect(missingSlackEnv(config, ["E2E_SLACK_BOT_TOKEN", "E2E_SLACK_REVIEWER_ID"])).toEqual([]);
  });

  it("treats them as optional and lists the missing names in order", () => {
    const config = loadLiveConfig({
      ...env,
      E2E_SLACK_BOT_TOKEN: undefined,
      E2E_SLACK_SIGNING_SECRET: "",
    });
    expect(config.slack.botToken).toBeUndefined();
    expect(
      missingSlackEnv(config, [
        "E2E_SLACK_SIGNING_SECRET",
        "E2E_SLACK_CHANNEL_ID",
        "E2E_SLACK_BOT_TOKEN",
      ]),
    ).toEqual(["E2E_SLACK_SIGNING_SECRET", "E2E_SLACK_BOT_TOKEN"]);
  });

  it.each([
    ["E2E_SLACK_BOT_TOKEN", ["xoxp", "x".repeat(20)].join("-")],
    ["E2E_SLACK_CHANNEL_ID", "c0e2e00001"],
    ["E2E_SLACK_SIGNING_SECRET", "short"],
    ["E2E_SLACK_REVIEWER_ID", "C0E2E00001"],
  ])("refuses a bad %s, naming it and never the value", (name, value) => {
    const error = failure({ ...env, [name]: value });
    expect(error.message).toContain(name);
    expect(error.message).not.toContain(value);
    for (const secret of [env.E2E_SLACK_BOT_TOKEN, env.E2E_SLACK_SIGNING_SECRET]) {
      expect(error.message).not.toContain(secret);
    }
  });

  it.each(["", "   ", "MarkerRealSecret".repeat(3)])(
    "refuses SLACK_SIGNING_SECRET set to %j, naming it and never the value",
    (value) => {
      const error = failure({ ...env, SLACK_SIGNING_SECRET: value });
      expect(error.message).toBe("SLACK_SIGNING_SECRET: must not be set in the live-test process");
      expect(JSON.stringify(error)).not.toContain("MarkerRealSecret");
      expect(String(error.stack)).not.toContain("MarkerRealSecret");
    },
  );
});
