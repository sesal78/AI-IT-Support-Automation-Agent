import { describe, expect, it } from "vitest";
import {
  aiBudgetEnvShape,
  e2eEnvShape,
  formatEnvIssues,
  groundingEnvShape,
  intakeEnvShape,
  internalEnvShape,
  langfuseEnvShape,
  llmEnvShape,
  parseEnv,
  phase1EnvShape,
  sensitiveCheckEnvShape,
  slackBotToken,
  slackChannelId,
  slackClientEnvShape,
  slackUserId,
  triggerProjectEnvShape,
} from "./env.js";

const valid = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
  SUPABASE_DB_SCHEMA: "itsupport",
  TRIGGER_SECRET_KEY: "fake-trigger-secret",
  SHADOW_MODE: "false",
  ADMIN_HEALTH_TOKEN: "fake-admin-health-token",
  APP_VERSION: "1.2.3",
};

describe("parseEnv", () => {
  it("parses a complete environment", () => {
    expect(parseEnv(phase1EnvShape, valid)).toEqual({ ...valid, SHADOW_MODE: false });
  });

  it("applies defaults for SUPABASE_DB_SCHEMA and SHADOW_MODE", () => {
    const env = parseEnv(phase1EnvShape, {
      ...valid,
      SUPABASE_DB_SCHEMA: undefined,
      SHADOW_MODE: "",
    });
    expect(env.SUPABASE_DB_SCHEMA).toBe("itsupport");
    expect(env.SHADOW_MODE).toBe(true);
  });

  it("names a missing variable in the error", () => {
    expect(() => parseEnv(phase1EnvShape, { ...valid, SUPABASE_URL: undefined })).toThrow(
      /SUPABASE_URL/,
    );
  });

  it("rejects SHADOW_MODE values other than true/false", () => {
    expect(() => parseEnv(phase1EnvShape, { ...valid, SHADOW_MODE: "maybe" })).toThrow(
      /SHADOW_MODE/,
    );
  });

  it("does not echo variable values in the error", () => {
    let message = "";
    try {
      parseEnv(phase1EnvShape, { ...valid, SUPABASE_URL: "not-a-url-secret-ish" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SUPABASE_URL");
    expect(message).not.toContain("not-a-url-secret-ish");
  });
});

describe("intakeEnvShape", () => {
  const turnstile = { TURNSTILE_SECRET_KEY: "fake-secret", TURNSTILE_SITE_KEY: "fake-site-key" };

  it("parses both Turnstile keys", () => {
    expect(parseEnv(intakeEnvShape, turnstile)).toEqual(turnstile);
  });

  it.each(["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"])("names %s when it is unset", (key) => {
    expect(() => parseEnv(intakeEnvShape, { ...turnstile, [key]: "" })).toThrow(key);
  });
});

describe("internalEnvShape", () => {
  const parse = (value: string | undefined) =>
    parseEnv(internalEnvShape, { INTERNAL_API_TOKEN: value });

  it("accepts exactly 32 letters and digits", () => {
    expect(parse("aB3".repeat(10) + "xy").INTERNAL_API_TOKEN).toHaveLength(32);
  });

  it.each([
    ["unset", undefined],
    ["31 characters", "a".repeat(31)],
    ["a hyphen", `${"a".repeat(31)}-`],
    ["an underscore", `${"a".repeat(31)}_`],
    [
      "a trailing newline",
      `${"a".repeat(32)}
`,
    ],
  ])("names INTERNAL_API_TOKEN when it is %s", (_label, value) => {
    expect(() => parse(value)).toThrow(/INTERNAL_API_TOKEN/);
  });
});

describe("formatEnvIssues", () => {
  it("handles object path segments and root issues", () => {
    const message = formatEnvIssues([
      { path: [{ key: "APP_VERSION" }], message: "Required" },
      { message: "Bad input" },
    ]);
    expect(message).toContain("APP_VERSION: Required");
    expect(message).toContain("(root): Bad input");
  });
});

describe("sensitiveCheckEnvShape", () => {
  const base = { TYPESAFE_API_KEY: "fake-typesafe-key" };

  it("defaults SENSITIVE_THRESHOLD to 0.5 when unset or empty", () => {
    expect(parseEnv(sensitiveCheckEnvShape, base).SENSITIVE_THRESHOLD).toBe(0.5);
    expect(
      parseEnv(sensitiveCheckEnvShape, { ...base, SENSITIVE_THRESHOLD: "" }).SENSITIVE_THRESHOLD,
    ).toBe(0.5);
  });

  it.each(["0", "0.25", "0.35", "1", "1.0"])(
    "accepts SENSITIVE_THRESHOLD=%s as a number",
    (value) => {
      expect(
        parseEnv(sensitiveCheckEnvShape, { ...base, SENSITIVE_THRESHOLD: value })
          .SENSITIVE_THRESHOLD,
      ).toBe(Number(value));
    },
  );

  it.each([" ", "	", "0x1", "0b1", "1e-1", ".5", "1.5", "-0", "-0.1", "abc"])(
    "rejects SENSITIVE_THRESHOLD=%s, naming it",
    (value) => {
      expect(() =>
        parseEnv(sensitiveCheckEnvShape, { ...base, SENSITIVE_THRESHOLD: value }),
      ).toThrow(/SENSITIVE_THRESHOLD/);
    },
  );

  it("requires TYPESAFE_API_KEY", () => {
    expect(() => parseEnv(sensitiveCheckEnvShape, {})).toThrow(/TYPESAFE_API_KEY/);
  });
});

describe("triggerProjectEnvShape", () => {
  it("accepts a Trigger.dev project ref", () => {
    const env = { TRIGGER_PROJECT_REF: "proj_abc123" };
    expect(parseEnv(triggerProjectEnvShape, env)).toEqual(env);
  });

  it.each([undefined, ""])("leaves TRIGGER_PROJECT_REF undefined for %j", (value) => {
    expect(
      parseEnv(triggerProjectEnvShape, { TRIGGER_PROJECT_REF: value }).TRIGGER_PROJECT_REF,
    ).toBeUndefined();
  });

  it.each(["my project", "PROJ_ABC", "proj_"])('rejects "%s", naming the variable', (value) => {
    expect(() => parseEnv(triggerProjectEnvShape, { TRIGGER_PROJECT_REF: value })).toThrow(
      /TRIGGER_PROJECT_REF/,
    );
  });
});

describe("e2eEnvShape", () => {
  const parse = (value: string | undefined) => parseEnv(e2eEnvShape, { E2E_MODE: value });

  it.each([
    ["unset", undefined, false],
    ["empty", "", false],
    ["false", "false", false],
    ["true", "true", true],
  ])("E2E_MODE %s parses to %s", (_label, value, expected) => {
    expect(parse(value).E2E_MODE).toBe(expected);
  });

  it.each(["TRUE", "True", "1", "yes", "false ", " true", "0"])(
    "rejects %j, naming E2E_MODE",
    (value) => {
      expect(() => parse(value)).toThrow(/E2E_MODE/);
    },
  );
});

describe("aiBudgetEnvShape", () => {
  it("defaults the caps to 2000 and 20000 when unset or empty", () => {
    expect(parseEnv(aiBudgetEnvShape, {})).toEqual({
      LLM_MONTHLY_CALL_CAP: 2000,
      TYPESAFE_MONTHLY_CALL_CAP: 20000,
    });
    expect(
      parseEnv(aiBudgetEnvShape, { LLM_MONTHLY_CALL_CAP: "", TYPESAFE_MONTHLY_CALL_CAP: "" }),
    ).toEqual({ LLM_MONTHLY_CALL_CAP: 2000, TYPESAFE_MONTHLY_CALL_CAP: 20000 });
  });

  it.each(["0", "1", "250", "1000000000"])(
    "accepts LLM_MONTHLY_CALL_CAP=%s as a number",
    (value) => {
      expect(parseEnv(aiBudgetEnvShape, { LLM_MONTHLY_CALL_CAP: value }).LLM_MONTHLY_CALL_CAP).toBe(
        Number(value),
      );
    },
  );

  it.each(["abc", "-1", "1e3", "1.5", " 5", "5 ", "0x10", "Infinity", "1000000001", "99999999999"])(
    "rejects LLM_MONTHLY_CALL_CAP=%j, naming the variable",
    (value) => {
      expect(() => parseEnv(aiBudgetEnvShape, { LLM_MONTHLY_CALL_CAP: value })).toThrow(
        /LLM_MONTHLY_CALL_CAP/,
      );
    },
  );

  it("rejects a bad TYPESAFE_MONTHLY_CALL_CAP, naming it and not echoing the value", () => {
    const bad = "x".repeat(3);
    let message = "";
    try {
      parseEnv(aiBudgetEnvShape, { TYPESAFE_MONTHLY_CALL_CAP: bad });
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain("TYPESAFE_MONTHLY_CALL_CAP");
    expect(message).not.toContain(bad);
  });
});

describe("langfuseEnvShape", () => {
  const ok = {
    LANGFUSE_PUBLIC_KEY: "pk-".concat("a".repeat(8)),
    LANGFUSE_SECRET_KEY: "sk-".concat("b".repeat(8)),
    LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
  };

  it("parses a complete environment", () => {
    expect(parseEnv(langfuseEnvShape, ok)).toEqual(ok);
  });

  it("names a missing LANGFUSE_SECRET_KEY", () => {
    expect(() => parseEnv(langfuseEnvShape, { ...ok, LANGFUSE_SECRET_KEY: undefined })).toThrow(
      /LANGFUSE_SECRET_KEY/,
    );
  });

  it.each(["not-a-url", "http://cloud.langfuse.com", "https://user:pw@cloud.langfuse.com"])(
    "rejects LANGFUSE_BASE_URL %s, naming the variable and not echoing it",
    (value) => {
      let message = "";
      try {
        parseEnv(langfuseEnvShape, { ...ok, LANGFUSE_BASE_URL: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("LANGFUSE_BASE_URL");
      expect(message).not.toContain(value);
    },
  );
});

describe("llmEnvShape", () => {
  const ok = {
    LLM_API_KEY: "x".repeat(16),
    LLM_BASE_URL: "https://opencode.ai/zen/go/v1",
    LLM_MODEL: "deepseek-v4.1-flash",
  };

  it("parses a complete environment", () => {
    expect(parseEnv(llmEnvShape, ok)).toEqual(ok);
  });

  it.each(["LLM_API_KEY", "LLM_MODEL"] as const)("names a missing %s", (name) => {
    expect(() => parseEnv(llmEnvShape, { ...ok, [name]: undefined })).toThrow(new RegExp(name));
  });

  it.each(["not-a-url", "http://opencode.ai/zen/go/v1", "https://user:pw@opencode.ai/zen/go/v1"])(
    "rejects LLM_BASE_URL %s, naming the variable and not echoing it",
    (value) => {
      let message = "";
      try {
        parseEnv(llmEnvShape, { ...ok, LLM_BASE_URL: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("LLM_BASE_URL");
      expect(message).not.toContain(value);
    },
  );
});

describe("groundingEnvShape", () => {
  it("defaults GROUNDING_MIN to 0.6 when unset or empty", () => {
    expect(parseEnv(groundingEnvShape, {}).GROUNDING_MIN).toBe(0.6);
    expect(parseEnv(groundingEnvShape, { GROUNDING_MIN: "" }).GROUNDING_MIN).toBe(0.6);
    expect(parseEnv(groundingEnvShape, { GROUNDING_MIN: "0.75" }).GROUNDING_MIN).toBe(0.75);
  });

  it.each(["1.5", "-0.1", "abc", " "])("rejects GROUNDING_MIN=%s, naming it", (value) => {
    expect(() => parseEnv(groundingEnvShape, { GROUNDING_MIN: value })).toThrow(/GROUNDING_MIN/);
  });
});

describe("triggerProjectEnvShape project-ref rule", () => {
  // Pinned with the copy in services/pipeline/src/project-ref.ts (see project-ref-parity.test.ts).
  it.each(["proj_ABC", "xproj_abc", "proj_abc-1", "proj_", " proj_abc", "proj_abc\n", "   "])(
    "rejects %j, naming the variable",
    (value) => {
      expect(() => parseEnv(triggerProjectEnvShape, { TRIGGER_PROJECT_REF: value })).toThrow(
        /TRIGGER_PROJECT_REF/,
      );
    },
  );
});

describe("slackUserId", () => {
  it.each(["U0123456789", "W012345678", "UE2EREVIEWER", "U012345678901", "W012345678901"])(
    "accepts %s",
    (id) => {
      expect(slackUserId().safeParse(id).success).toBe(true);
    },
  );

  it.each([
    "U1234567",
    "W1234567",
    "U0123456789012",
    "W0123456789012",
    "U0123456789ABCDEFGHIJ",
    "u0123456789",
    "C0123456789",
    "U0123456789 ",
    "U0123456789\n",
    "",
  ])("rejects %j", (id) => {
    expect(slackUserId().safeParse(id).success).toBe(false);
  });
});

describe("slackClientEnvShape", () => {
  // Fake values built from pieces, so no file holds anything shaped like a real token.
  const token = ["xoxb", "0000000000", "fake"].join("-");
  const valid = { SLACK_BOT_TOKEN: token, SLACK_CHANNEL_ID: "C0000000001" };

  it("parses valid values, with SLACK_ALERT_CHANNEL_ID unset", () => {
    expect(parseEnv(slackClientEnvShape, valid)).toEqual({ ...valid });
  });

  it("parses SLACK_ALERT_CHANNEL_ID when set, and treats an empty one as unset", () => {
    const withAlert = { ...valid, SLACK_ALERT_CHANNEL_ID: "G0000000002" };
    expect(parseEnv(slackClientEnvShape, withAlert)).toEqual(withAlert);
    expect(parseEnv(slackClientEnvShape, { ...valid, SLACK_ALERT_CHANNEL_ID: "" })).toEqual(valid);
  });

  it.each([
    ["SLACK_BOT_TOKEN", ["xoxp", "0000000000", "fake"].join("-")],
    ["SLACK_BOT_TOKEN", "xoxb-short"],
    ["SLACK_CHANNEL_ID", "#general"],
    ["SLACK_CHANNEL_ID", "c0000000001"],
    ["SLACK_CHANNEL_ID", "C000"],
    ["SLACK_CHANNEL_ID", "U0000000001"],
    ["SLACK_ALERT_CHANNEL_ID", "#general"],
    ["SLACK_ALERT_CHANNEL_ID", "c0000000001"],
    ["SLACK_ALERT_CHANNEL_ID", "C000"],
  ])("rejects %s=%j, naming the variable and not echoing the value", (key, value) => {
    let message = "";
    try {
      parseEnv(slackClientEnvShape, { ...valid, [key]: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(key);
    expect(message).not.toContain(value);
  });

  it("requires SLACK_BOT_TOKEN and SLACK_CHANNEL_ID", () => {
    expect(() => parseEnv(slackClientEnvShape, { ...valid, SLACK_BOT_TOKEN: "" })).toThrow(
      /SLACK_BOT_TOKEN/,
    );
    expect(() => parseEnv(slackClientEnvShape, { ...valid, SLACK_CHANNEL_ID: "" })).toThrow(
      /SLACK_CHANNEL_ID/,
    );
  });
});

describe("Slack format rules", () => {
  it.each(["C00000000", "G000000000000"])("slackChannelId accepts %j", (id) => {
    expect(slackChannelId().safeParse(id).success).toBe(true);
  });

  it.each(["C0000000", "C00000000000000", "D00000000", "C00000000\n"])(
    "slackChannelId rejects %j",
    (id) => {
      expect(slackChannelId().safeParse(id).success).toBe(false);
    },
  );

  it("slackBotToken accepts xoxb- plus 10 or more letters, digits or dashes only", () => {
    expect(slackBotToken().safeParse(["xoxb", "0000-00000"].join("-")).success).toBe(true);
    expect(slackBotToken().safeParse(["xoxb", "000000000"].join("-")).success).toBe(false);
    expect(slackBotToken().safeParse(["xoxb", "0000000000 x"].join("-")).success).toBe(false);
    expect(slackBotToken().safeParse(["xoxb", "0000000000\r\nX: y"].join("-")).success).toBe(false);
  });
});
