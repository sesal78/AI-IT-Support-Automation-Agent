import { describe, expect, it } from "vitest";
import { E2E_SERVICENOW_INSTANCE_URL, liveServiceNowEnvShape, parseEnv } from "./env.js";

const valid = {
  E2E_SERVICENOW_INSTANCE_URL: E2E_SERVICENOW_INSTANCE_URL,
  E2E_SERVICENOW_USERNAME: "svc.itsupport",
  E2E_SERVICENOW_PASSWORD: "MarkerSnPassword-0123456789",
};

function message(source: Record<string, string | undefined>): string {
  try {
    parseEnv(liveServiceNowEnvShape, source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseEnv to throw");
}

describe("liveServiceNowEnvShape", () => {
  it("parses valid values, and treats every name as optional", () => {
    expect(parseEnv(liveServiceNowEnvShape, valid)).toEqual(valid);
    expect(parseEnv(liveServiceNowEnvShape, {})).toEqual({});
    expect(parseEnv(liveServiceNowEnvShape, { E2E_SERVICENOW_PASSWORD: "" })).toEqual({});
  });

  it("the instance URL is exactly https://dev420188.service-now.com", () => {
    expect(E2E_SERVICENOW_INSTANCE_URL).toBe("https://dev420188.service-now.com");
  });

  it.each([
    "https://other.service-now.com",
    "https://dev420188.service-now.com/",
    "http://dev420188.service-now.com",
    "https://dev420188.service-now.com:443",
    " https://dev420188.service-now.com",
    "https://user:pw@dev420188.service-now.com",
  ])("a bad URL %s fails, naming the variable", (url) => {
    const text = message({ ...valid, E2E_SERVICENOW_INSTANCE_URL: url });
    expect(text).toContain("E2E_SERVICENOW_INSTANCE_URL");
    expect(text).not.toContain("pw@");
  });

  it("a user name that is not header-safe fails, naming the variable and not quoting it", () => {
    const text = message({ ...valid, E2E_SERVICENOW_USERNAME: "svc itsupport" });
    expect(text).toContain("E2E_SERVICENOW_USERNAME");
    expect(text).not.toContain("svc itsupport");
  });
});
