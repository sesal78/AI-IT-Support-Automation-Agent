import { describe, expect, it } from "vitest";
import { liveSlackEnvShape, parseEnv, reviewEnvShape, slackInteractivityEnvShape } from "./env.js";

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

describe("slackInteractivityEnvShape", () => {
  const base = {
    SLACK_SIGNING_SECRET: "k".repeat(32),
    SLACK_REVIEWER_IDS: "U0A5ATR4WJD",
    SLACK_CHANNEL_ID: "C0000000001",
  };
  const refusal = (source: Record<string, string | undefined>): string => {
    try {
      parseEnv(slackInteractivityEnvShape, source);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected parseEnv to throw");
  };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `U${String(i).padStart(10, "0")}`);

  it("parses SLACK_REVIEWER_IDS into a list of one or more IDs", () => {
    expect(parseEnv(slackInteractivityEnvShape, base)).toEqual({
      ...base,
      SLACK_REVIEWER_IDS: ["U0A5ATR4WJD"],
    });
    const two = { ...base, SLACK_REVIEWER_IDS: "UE2EREVIEWER,U0000000001" };
    expect(parseEnv(slackInteractivityEnvShape, two).SLACK_REVIEWER_IDS).toEqual([
      "UE2EREVIEWER",
      "U0000000001",
    ]);
    const twenty = { ...base, SLACK_REVIEWER_IDS: ids(20).join(",") };
    expect(parseEnv(slackInteractivityEnvShape, twenty).SLACK_REVIEWER_IDS).toHaveLength(20);
  });

  it.each([
    ["SLACK_SIGNING_SECRET", undefined],
    ["SLACK_SIGNING_SECRET", "k".repeat(31)],
    ["SLACK_SIGNING_SECRET", `${"k".repeat(32)}-`],
    ["SLACK_REVIEWER_IDS", undefined],
    ["SLACK_REVIEWER_IDS", ""],
    ["SLACK_REVIEWER_IDS", "u0a5atr4wjd"],
    ["SLACK_REVIEWER_IDS", "U1 ,U2"],
    ["SLACK_REVIEWER_IDS", "U0000000001 ,U0000000002"],
    ["SLACK_REVIEWER_IDS", "U0000000001,"],
    ["SLACK_REVIEWER_IDS", "U0000000001,U0000000001"],
    ["SLACK_REVIEWER_IDS", ids(21).join(",")],
    ["SLACK_CHANNEL_ID", undefined],
    ["SLACK_CHANNEL_ID", "c0000000001"],
  ])("refuses %s = %j, naming it and never quoting the value", (name, value) => {
    const text = refusal({ ...base, [name]: value });
    expect(text).toContain(name);
    if (value) expect(text).not.toContain(value.trim());
  });
});

describe("reviewEnvShape", () => {
  const timeout = (value?: string) =>
    parseEnv(reviewEnvShape, { SLACK_REVIEW_TIMEOUT: value }).SLACK_REVIEW_TIMEOUT;

  it("defaults to 24h and accepts 1m to 7d", () => {
    expect(timeout()).toBe("24h");
    expect(timeout("")).toBe("24h");
    for (const value of ["1m", "2m", "9999m", "168h", "7d"]) expect(timeout(value)).toBe(value);
  });

  it.each(["24", "0h", "8d", "169h", "10081m", "1s", "24H", " 24h", "12345m"])(
    "rejects %j, naming SLACK_REVIEW_TIMEOUT",
    (value) => {
      expect(() => timeout(value)).toThrow(/SLACK_REVIEW_TIMEOUT/);
    },
  );
});
