import { afterEach, describe, expect, it, vi } from "vitest";

const env = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_DB_SCHEMA: "itsupport",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("createDbClient", () => {
  it("throws when imported in a browser module (window is defined)", async () => {
    vi.stubGlobal("window", {});
    await expect(import("./client.js")).rejects.toThrow(/server-only/);
  });

  it("names the invalid variable but never echoes the key", async () => {
    const { createDbClient } = await import("./client.js");
    expect(() => createDbClient({ ...env, SUPABASE_URL: "not a url" })).toThrow(/SUPABASE_URL/);
    expect(() => createDbClient({ ...env, SUPABASE_SERVICE_ROLE_KEY: "" })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
    try {
      createDbClient({ ...env, SUPABASE_URL: "" });
    } catch (error) {
      expect(String(error)).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
    }
  });

  it("sends requests to <url>/rest/v1 with the service key and the configured schema", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    const { createDbClient } = await import("./client.js");

    const { error } = await createDbClient(env).from("tickets").select();

    expect(error).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit];
    expect(String(url)).toBe("http://127.0.0.1:54321/rest/v1/tickets?select=*");
    const headers = new Headers(init.headers);
    expect(headers.get("accept-profile")).toBe("itsupport");
    expect(headers.get("authorization")).toBe(`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
  });

  it("defaults the schema to itsupport", async () => {
    const fetchMock = vi.fn(async () => Response.json([]));
    vi.stubGlobal("fetch", fetchMock);
    const { createDbClient } = await import("./client.js");

    await createDbClient({ ...env, SUPABASE_DB_SCHEMA: undefined })
      .from("tickets")
      .select();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("accept-profile")).toBe("itsupport");
  });
});
