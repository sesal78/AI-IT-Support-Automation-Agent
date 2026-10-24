import { describe, expect, it } from "vitest";
import { loadLiveConfig, LiveConfigError } from "./config.ts";
import { markerEnv } from "./testing/env.ts";

const env = markerEnv("https://e2e.example.com");

function failure(source: Record<string, string | undefined>): LiveConfigError {
  try {
    loadLiveConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(LiveConfigError);
    return error as LiveConfigError;
  }
  throw new Error("expected loadLiveConfig to throw");
}

function expectNoValue(message: string, source: Record<string, string | undefined>): void {
  for (const value of Object.values(source)) {
    if (value !== undefined && value.length > 8) expect(message).not.toContain(value);
  }
}

describe("loadLiveConfig", () => {
  it("reads every variable by name", () => {
    const config = loadLiveConfig(env);
    expect(config.origin).toBe("https://e2e.example.com");
    expect(config.host).toBe("e2e.example.com");
    expect(config.internalApiToken).toBe(env.INTERNAL_API_TOKEN);
    expect(config.accessClientId).toBe(env.CF_ACCESS_CLIENT_ID);
    expect(config.accessClientSecret).toBe(env.CF_ACCESS_CLIENT_SECRET);
    expect(config.stagingOrigin).toBe(new URL(env.STAGING_BASE_URL).origin);
    expect(config.langfuse.secretKey).toBe(env.LANGFUSE_SECRET_KEY);
    expect(config.secrets).toContain(env.CF_ACCESS_CLIENT_SECRET);
  });

  it.each(["E2E_BASE_URL", "INTERNAL_API_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"])(
    "names %s when it is missing or empty, and quotes no value",
    (name) => {
      for (const value of [undefined, ""]) {
        const source = { ...env, [name]: value };
        const error = failure(source);
        expect(error.message).toContain(name);
        expectNoValue(error.message, env);
      }
    },
  );

  it("treats STAGING_BASE_URL and the Langfuse keys as optional", () => {
    const config = loadLiveConfig({
      ...env,
      STAGING_BASE_URL: undefined,
      LANGFUSE_PUBLIC_KEY: undefined,
      LANGFUSE_SECRET_KEY: undefined,
      LANGFUSE_BASE_URL: undefined,
    });
    expect(config.stagingOrigin).toBeUndefined();
    expect(config.langfuse.publicKey).toBeUndefined();
  });

  it("accepts https and http://127.0.0.1:<port> only", () => {
    expect(loadLiveConfig({ ...env, E2E_BASE_URL: "http://127.0.0.1:4310" }).origin).toBe(
      "http://127.0.0.1:4310",
    );
    for (const bad of [
      "http://e2e.example.com",
      "http://127.0.0.1",
      "http://localhost:4310",
      "ftp://e2e.example.com",
      "https://user:pass@e2e.example.com",
      "https://e2e.example.com/?x=1",
      "https://e2e.example.com/#x",
      "not a url",
    ]) {
      const error = failure({ ...env, E2E_BASE_URL: bad });
      expect(error.message, bad).toContain("E2E_BASE_URL");
      // The rule itself names http://127.0.0.1, so that one case cannot be checked.
      if (bad !== "http://127.0.0.1") expect(error.message, bad).not.toContain(bad);
    }
  });

  it("refuses the host of STAGING_BASE_URL with the staging message", () => {
    const error = failure({
      ...env,
      E2E_BASE_URL: "https://preview.example.org",
      STAGING_BASE_URL: "https://PREVIEW.example.org:8443/some/path",
    });
    expect(error.message).toBe("E2E_BASE_URL: live tests never run against staging");
    expect(error.message).not.toContain("preview");
  });

  it.each([
    ["a trailing dot on E2E_BASE_URL", "https://qa.example.com.", "https://qa.example.com"],
    ["a trailing dot on STAGING_BASE_URL", "https://qa.example.com", "https://qa.example.com."],
    ["a trailing dot on both", "https://qa.example.com.", "https://qa.example.com."],
    ["upper case", "https://QA.Example.COM.", "https://qa.EXAMPLE.com"],
  ])("refuses the staging host written with %s", (_case, e2e, staging) => {
    const error = failure({ ...env, E2E_BASE_URL: e2e, STAGING_BASE_URL: staging });
    expect(error.message).toBe("E2E_BASE_URL: live tests never run against staging");
  });

  it("refuses a staging first label written with a trailing dot or upper case", () => {
    for (const host of ["staging.", "STAGING.example.com.", "Qa-Staging.example.com"]) {
      const error = failure({
        ...env,
        E2E_BASE_URL: `https://${host}`,
        STAGING_BASE_URL: undefined,
      });
      expect(error.message, host).toBe("E2E_BASE_URL: live tests never run against staging");
    }
  });

  it("refuses a host whose first label contains staging, even with STAGING_BASE_URL unset", () => {
    for (const host of ["staging.example.com", "app-staging.example.com", "STAGING2.example.com"]) {
      const error = failure({
        ...env,
        E2E_BASE_URL: `https://${host}`,
        STAGING_BASE_URL: undefined,
      });
      expect(error.message, host).toBe("E2E_BASE_URL: live tests never run against staging");
    }
    // Only the first label counts.
    expect(() =>
      loadLiveConfig({ ...env, E2E_BASE_URL: "https://e2e.staging-tools.example.com" }),
    ).not.toThrow();
  });

  it("refuses Access values a header cannot carry, without quoting them", () => {
    for (const bad of [
      `a b${"x".repeat(20)}`,
      `line\r\nX-Evil: 1${"x".repeat(20)}`,
      `é${"x".repeat(20)}`,
    ]) {
      const error = failure({ ...env, CF_ACCESS_CLIENT_SECRET: bad });
      expect(error.message).toContain("CF_ACCESS_CLIENT_SECRET");
      expect(error.message).not.toContain(bad);
    }
  });

  it("refuses a malformed INTERNAL_API_TOKEN without quoting it", () => {
    const bad = `short-${"x".repeat(10)}`;
    const error = failure({ ...env, INTERNAL_API_TOKEN: bad });
    expect(error.message).toContain("INTERNAL_API_TOKEN");
    expect(error.message).not.toContain(bad);
  });
});
