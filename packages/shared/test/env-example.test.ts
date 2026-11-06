import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aiBudgetEnvShape,
  e2eEnvShape,
  groundingEnvShape,
  intakeEnvShape,
  internalEnvShape,
  langfuseEnvShape,
  llmEnvShape,
  liveEnvShape,
  liveSlackEnvShape,
  parseEnv,
  phase1EnvShape,
  policyEnvShape,
  reviewEnvShape,
  sensitiveCheckEnvShape,
  slackClientEnvShape,
  slackInteractivityEnvShape,
  triggerProjectEnvShape,
} from "../src/env.js";

// Every env shape whose keys belong in .env.example.
const allEnvShapes = {
  ...phase1EnvShape,
  ...intakeEnvShape,
  ...internalEnvShape,
  ...e2eEnvShape,
  ...aiBudgetEnvShape,
  ...sensitiveCheckEnvShape,
  ...triggerProjectEnvShape,
  ...langfuseEnvShape,
  ...policyEnvShape,
  ...groundingEnvShape,
  ...llmEnvShape,
  ...liveEnvShape,
  ...liveSlackEnvShape,
  ...slackInteractivityEnvShape,
  ...slackClientEnvShape,
  ...reviewEnvShape,
  // Every value the bot token rule accepts starts with xoxb-, which the secret
  // check below bans, so its placeholder is empty (the key store fills it). The
  // parse treats it as optional here only; the "empty" test pins that.
  SLACK_BOT_TOKEN: slackClientEnvShape.SLACK_BOT_TOKEN.optional(),
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const example = readFileSync(resolve(repoRoot, ".env.example"), "utf8");

// KEY=value lines only; comments and blank lines are ignored.
const entries = example
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => {
    const eq = line.indexOf("=");
    return [line.slice(0, eq), line.slice(eq + 1)] as const;
  });

describe(".env.example", () => {
  it("has exactly the keys of the env schemas", () => {
    const keys = entries.map(([key]) => key).sort();
    expect(keys).toEqual(Object.keys(allEnvShapes).sort());
  });

  it("contains only short placeholder values", () => {
    for (const [key, value] of entries) {
      expect(value.length, key).toBeLessThanOrEqual(40);
    }
  });

  it("contains nothing that looks like a real secret", () => {
    expect(example).not.toMatch(/(^|[^A-Za-z0-9])(sk-|eyJ|xoxb-)/);
  });

  it("parses against the schema", () => {
    expect(() => parseEnv(allEnvShapes, Object.fromEntries(entries))).not.toThrow();
  });

  it("leaves the Slack bot token placeholder empty", () => {
    expect(entries.filter(([key]) => key === "SLACK_BOT_TOKEN")).toEqual([["SLACK_BOT_TOKEN", ""]]);
  });
});
