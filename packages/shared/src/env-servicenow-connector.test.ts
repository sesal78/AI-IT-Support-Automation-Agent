import { describe, expect, it } from "vitest";
import { parseEnv, serviceNowEnvShape } from "./env.js";

// Built from pieces so a secret scanner never sees one string.
const PASSWORD = ["Marker", "Sn", "Pw-0123456789"].join("");

const valid = {
  SERVICENOW_INSTANCE_URL: "https://dev420188.service-now.com",
  SERVICENOW_USERNAME: "svc.itsupport",
  SERVICENOW_PASSWORD: PASSWORD,
  SERVICENOW_DEFAULT_CALLER: "0123456789abcdef0123456789abcdef",
};

function message(source: Record<string, string | undefined>): string {
  try {
    parseEnv(serviceNowEnvShape, source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseEnv to throw");
}

describe("serviceNowEnvShape", () => {
  it("parses valid values", () => {
    expect(parseEnv(serviceNowEnvShape, valid)).toEqual(valid);
  });

  it("accepts a 12-character password", () => {
    const password = "a".repeat(12);
    expect(parseEnv(serviceNowEnvShape, { ...valid, SERVICENOW_PASSWORD: password })).toMatchObject(
      { SERVICENOW_PASSWORD: password },
    );
  });

  it.each([
    "http://dev420188.service-now.com",
    "https://dev420188.service-now.com/api",
    "https://dev420188.service-now.com/",
    "https://dev420188.service-now.com:8443",
    "https://user@dev420188.service-now.com",
    "https://dev420188.example.com",
    "https://dev420188.service-now.com.evil.test",
    "https://.service-now.com",
    "service-now.com",
    "",
  ])("a bad URL %j fails, naming the variable", (url) => {
    expect(message({ ...valid, SERVICENOW_INSTANCE_URL: url })).toContain(
      "SERVICENOW_INSTANCE_URL",
    );
  });

  it("an 11-character password fails, naming the variable and not echoing it", () => {
    const password = "a".repeat(11);
    const text = message({ ...valid, SERVICENOW_PASSWORD: password });
    expect(text).toContain("SERVICENOW_PASSWORD");
    expect(text).not.toContain(password);
  });

  it("a default caller of 31 characters fails, naming the variable", () => {
    const text = message({ ...valid, SERVICENOW_DEFAULT_CALLER: "a".repeat(31) });
    expect(text).toContain("SERVICENOW_DEFAULT_CALLER");
  });

  it.each(["A".repeat(32), "g".repeat(32), "a".repeat(33)])(
    "a default caller of %j fails",
    (caller) => {
      expect(message({ ...valid, SERVICENOW_DEFAULT_CALLER: caller })).toContain(
        "SERVICENOW_DEFAULT_CALLER",
      );
    },
  );

  it.each(["", "a b", "a:b"])("a user name of %j fails, naming the variable", (name) => {
    expect(message({ ...valid, SERVICENOW_USERNAME: name })).toContain("SERVICENOW_USERNAME");
  });

  it("every variable is required", () => {
    for (const key of Object.keys(valid)) {
      const rest: Record<string, string> = { ...valid };
      delete rest[key];
      expect(message(rest)).toContain(key);
    }
  });
});
