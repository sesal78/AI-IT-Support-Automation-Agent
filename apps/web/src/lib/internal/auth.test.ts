import { beforeEach, describe, expect, it, vi } from "vitest";

const recordSecurityEvent = vi.hoisted(() => vi.fn());
const timingSafeEqual = vi.hoisted(() => vi.fn());

vi.mock("@ai-it-support/db", () => ({
  createDbClient: () => ({}),
  createRepositories: () => ({ recordSecurityEvent }),
}));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual };
});

const TOKEN = "fakeInternalApiToken0123456789ABCDEF";

type Guard = (request: Request) => Promise<Response | null>;
let requireInternalAuth: Guard;

function req(headers: Record<string, string> = {}, url = "http://localhost/api/internal/x") {
  return new Request(url, { method: "POST", headers });
}
const bearer = (token: string) => req({ authorization: `Bearer ${token}` });

async function expectRefused(request: Request, kind: string) {
  const response = await requireInternalAuth(request);
  expect(response?.status).toBe(401);
  expect(await response?.json()).toEqual({ error: "unauthorized" });
  expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
  expect(recordSecurityEvent.mock.calls[0]?.[0]).toBe("internal_api");
  expect(recordSecurityEvent.mock.calls[0]?.[1]).toBe(kind);
}

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "1.0.0-test");
  vi.stubEnv("INTERNAL_API_TOKEN", TOKEN);
  recordSecurityEvent.mockReset();
  recordSecurityEvent.mockResolvedValue(undefined);
  timingSafeEqual.mockClear();
  ({ requireInternalAuth } = await import("./auth"));
});

describe("requireInternalAuth: accepted", () => {
  it.each(["Bearer", "bearer", "BEARER", "bEaReR"])("passes with scheme %s", async (scheme) => {
    expect(await requireInternalAuth(req({ authorization: `${scheme} ${TOKEN}` }))).toBeNull();
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });
});

describe("requireInternalAuth: missing_token", () => {
  it.each([
    ["no header", req()],
    ["empty Bearer token", req({ authorization: "Bearer " })],
    ["Bearer without a space", req({ authorization: "Bearer" })],
    ["only x-admin-token", req({ "x-admin-token": TOKEN })],
  ])("%s", async (_label, request) => {
    await expectRefused(request, "missing_token");
  });
});

describe("requireInternalAuth: bad_token", () => {
  it.each([
    ["same length", `${TOKEN.slice(0, -1)}X`],
    ["shorter", TOKEN.slice(0, 10)],
    ["longer", `${TOKEN}${TOKEN}`],
    ["trailing character", `${TOKEN}x`],
    ["leading space", ` ${TOKEN}`],
    ["comma-joined second value", `${TOKEN}, Bearer ${TOKEN}`],
    ["look-alike latin-1 character", TOKEN.replace("a", "à")],
  ])("wrong token: %s", async (_label, token) => {
    await expectRefused(bearer(token), "bad_token");
  });

  it.each([
    ["Basic scheme", `Basic ${TOKEN}`],
    ["tab separator", `Bearer\t${TOKEN}`],
    ["bare token", TOKEN],
  ])("%s", async (_label, value) => {
    await expectRefused(req({ authorization: value }), "bad_token");
  });

  it("handles a 1 MB header without throwing or stalling", async () => {
    const started = Date.now();
    await expectRefused(bearer("a".repeat(1_000_000)), "bad_token");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("requireInternalAuth: token_in_query", () => {
  const base = "http://localhost/api/internal/x";
  it.each([
    "?token=abc",
    "?access_token=abc",
    "?token=",
    "?access_token",
    "?TOKEN=abc",
    "?Token=abc",
    "?Access_Token=abc",
    "?%74oken=abc",
    "?access%5Ftoken=abc",
    "?a=1&token=x&token=y",
    `?token=${TOKEN}`,
    `?access_token=${TOKEN}`,
  ])("refuses %s even with a valid header", async (query) => {
    await expectRefused(req({ authorization: `Bearer ${TOKEN}` }, base + query), "token_in_query");
  });

  it("refuses the query token with no header", async () => {
    await expectRefused(req({}, `${base}?token=${TOKEN}`), "token_in_query");
  });

  it("ignores a token in the fragment and unrelated parameters", async () => {
    const ok = req({ authorization: `Bearer ${TOKEN}` }, `${base}?tokens=1&x=token#token=1`);
    expect(await requireInternalAuth(ok)).toBeNull();
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });
});

describe("requireInternalAuth: uniform response", () => {
  it("gives the three refusals the same status, body and headers", async () => {
    const a = await requireInternalAuth(req());
    const b = await requireInternalAuth(bearer("wrong"));
    const c = await requireInternalAuth(req({}, "http://localhost/x?token=1"));
    const shape = async (r: Response | null) => [
      r?.status,
      await r?.text(),
      [...(r?.headers ?? [])].sort(),
    ];
    const first = await shape(a);
    expect(first[0]).toBe(401);
    expect(await shape(b)).toEqual(first);
    expect(await shape(c)).toEqual(first);
  });
});

describe("requireInternalAuth: constant-time compare", () => {
  it.each([TOKEN.slice(0, 5), `${TOKEN}${TOKEN}`, `${TOKEN.slice(0, -1)}X`, TOKEN])(
    "calls timingSafeEqual once with equal-length buffers",
    async (token) => {
      await requireInternalAuth(bearer(token));
      expect(timingSafeEqual).toHaveBeenCalledTimes(1);
      const [a, b] = timingSafeEqual.mock.calls[0] as [Buffer, Buffer];
      expect(a.length).toBe(b.length);
    },
  );
});

describe("requireInternalAuth: security event sample", () => {
  it("holds only path and method, never the query, token or IP", async () => {
    const request = req(
      {
        authorization: `Bearer ${TOKEN}x`,
        "x-forwarded-for": "203.0.113.9",
        "cf-connecting-ip": "203.0.113.9",
      },
      "http://localhost/api/internal/x?token=secret-q#frag",
    );
    await requireInternalAuth(request);
    expect(recordSecurityEvent).toHaveBeenCalledWith("internal_api", "token_in_query", {
      path: "/api/internal/x",
      method: "POST",
    });
    const serialized = JSON.stringify(recordSecurityEvent.mock.calls);
    for (const leak of ["secret-q", TOKEN, "203.0.113.9", "frag", "?"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it.each([
    ["http://localhost/a;b=1?token=1", "/a;b=1"],
    ["http://localhost/a%3Ftoken=1", "/a%3Ftoken=1"],
    ["http://localhost/a%3Ftoken=1?x=1", "/a%3Ftoken=1"],
  ])("keeps only the path of %s", async (url, path) => {
    await requireInternalAuth(req({}, url));
    const sample = recordSecurityEvent.mock.calls[0]?.[2] as { path: string };
    expect(sample.path).toBe(path);
    expect(Object.keys(sample).sort()).toEqual(["method", "path"]);
  });

  it("caps a very long path", async () => {
    await requireInternalAuth(req({}, `http://localhost/${"a".repeat(5000)}`));
    const sample = recordSecurityEvent.mock.calls[0]?.[2] as { path: string };
    expect(sample.path).toHaveLength(200);
  });
});

describe("requireInternalAuth: recording failure", () => {
  it("still returns 401 and logs the error class name only", async () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    class DbError extends Error {
      constructor() {
        super(`boom ${TOKEN}`);
        this.name = "DbError";
      }
    }
    recordSecurityEvent.mockRejectedValue(new DbError());
    const response = await requireInternalAuth(bearer("wrong"));
    expect(response?.status).toBe(401);
    expect(logError).toHaveBeenCalledTimes(1);
    expect(String(logError.mock.calls[0]?.[0])).toContain("DbError");
    expect(JSON.stringify(logError.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(logError.mock.calls)).not.toContain("boom");
    logError.mockRestore();
  });

  it("logs 'unknown' for a thrown non-Error", async () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    recordSecurityEvent.mockRejectedValue("nope");
    const response = await requireInternalAuth(req());
    expect(response?.status).toBe(401);
    expect(String(logError.mock.calls[0]?.[0])).toContain("unknown");
    logError.mockRestore();
  });
});
