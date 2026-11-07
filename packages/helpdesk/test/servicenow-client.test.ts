import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HelpdeskError,
  InstanceAsleepError,
  createServiceNowClient,
  type HelpdeskErrorCode,
  type ServiceNowClient,
} from "../src/index.js";

const ORIGIN = "https://example.service-now.com";
// Built from pieces so a secret scanner never sees one string.
const PASSWORD = ["Mark", "er", "Pw", "-0123456789"].join("");
const HIBERNATING = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/servicenow-hibernating.html"),
  "utf8",
);

type Reply = () => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setup(reply: Reply, timeoutMs?: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(reply());
  });
  const client: ServiceNowClient = createServiceNowClient({
    instanceUrl: ORIGIN,
    username: "svc.itsupport",
    password: PASSWORD,
    fetch: fetchMock as unknown as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { client, calls, fetchMock };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

const query = { fields: ["number"] };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("responses", () => {
  it("a 2xx JSON body gives its result, for get, post and patch", async () => {
    const { client, calls } = setup(() => json({ result: [{ number: "INC0010001" }] }));
    expect(await client.get("incident", query)).toEqual([{ number: "INC0010001" }]);
    expect(await client.post("incident", { short_description: "x" }, ["number"])).toEqual([
      { number: "INC0010001" },
    ]);
    const sysId = "0123456789abcdef0123456789abcdef";
    await client.patch("incident", sysId, { state: 2 });
    expect(calls.map((c) => [c.init.method, new URL(c.url).pathname])).toEqual([
      ["GET", "/api/now/table/incident"],
      ["POST", "/api/now/table/incident"],
      ["PATCH", `/api/now/table/incident/${sysId}`],
    ]);
    expect(calls[1]?.init.body).toBe(JSON.stringify({ short_description: "x" }));
    expect(new URL((calls[1] as { url: string }).url).searchParams.get("sysparm_fields")).toBe(
      "number",
    );
    expect(new URL((calls[2] as { url: string }).url).search).toBe("");
  });

  it("sends Basic auth, Accept JSON and redirect manual", async () => {
    const { client, calls } = setup(() => json({ result: [] }));
    await client.get("incident", query);
    const init = calls[0]?.init as RequestInit;
    expect(init.redirect).toBe("manual");
    expect(init.headers).toMatchObject({
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`svc.itsupport:${PASSWORD}`).toString("base64")}`,
    });
  });

  it.each<[number, HelpdeskErrorCode, boolean]>([
    [401, "auth", false],
    [403, "auth", false],
    [404, "not_found", false],
    [400, "bad_request", false],
    [409, "bad_request", false],
    [429, "rate_limited", true],
    [500, "unavailable", true],
    [502, "unavailable", true],
    [503, "unavailable", true],
  ])("status %i is a HelpdeskError %s, retryable %s", async (status, code, retryable) => {
    const { client } = setup(() => new Response("{}", { status }));
    const error = await failure(client.get("incident", query));
    expect(error).toBeInstanceOf(HelpdeskError);
    expect(error).not.toBeInstanceOf(InstanceAsleepError);
    expect(error).toMatchObject({ code, retryable });
  });

  it("a 503 whose body is the hibernation page is still unavailable, never asleep", async () => {
    const { client } = setup(() => new Response(HIBERNATING, { status: 503 }));
    const error = await failure(client.get("incident", query));
    expect(error).not.toBeInstanceOf(InstanceAsleepError);
    expect(error).toMatchObject({ code: "unavailable", retryable: true });
  });

  it("a network error is unavailable", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const client = createServiceNowClient({
      instanceUrl: ORIGIN,
      username: "u",
      password: PASSWORD,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await failure(client.get("incident", query))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });
});

// T5.U.03
describe("T5.U.03 sleeping instance and timeout", () => {
  it("the hibernation sample is an InstanceAsleepError", async () => {
    const { client } = setup(
      () => new Response(HIBERNATING, { status: 200, headers: { "content-type": "text/html" } }),
    );
    const error = await failure(client.get("incident", query));
    expect(error).toBeInstanceOf(InstanceAsleepError);
    expect(error).toBeInstanceOf(HelpdeskError);
    expect(error).toMatchObject({ code: "asleep", retryable: true });
  });

  it("a 302 to the developer portal is an InstanceAsleepError", async () => {
    const { client, fetchMock } = setup(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://developer.servicenow.com/dev.do#!/home" },
        }),
    );
    const error = await failure(client.get("incident", query));
    expect(error).toBeInstanceOf(InstanceAsleepError);
    expect(error).toMatchObject({ code: "asleep", retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("any other redirect is bad_response and is not followed", async () => {
    const { client, fetchMock } = setup(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    );
    const error = await failure(client.get("incident", query));
    expect(error).toMatchObject({ code: "bad_response", retryable: false });
    expect(error).not.toBeInstanceOf(InstanceAsleepError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a redirect with no Location is bad_response", async () => {
    const { client } = setup(() => new Response(null, { status: 301 }));
    expect(await failure(client.get("incident", query))).toMatchObject({ code: "bad_response" });
  });

  it("a non-JSON 200 without the marker is bad_response", async () => {
    const { client } = setup(() => new Response("<html><body>Welcome</body></html>"));
    const error = await failure(client.get("incident", query));
    expect(error).toMatchObject({ code: "bad_response", retryable: false });
    expect(error).not.toBeInstanceOf(InstanceAsleepError);
  });

  it("JSON without a result is bad_response", async () => {
    const { client } = setup(() => json({ error: { message: "x" } }));
    expect(await failure(client.get("incident", query))).toMatchObject({ code: "bad_response" });
  });

  it("a request that does not answer within the timeout is unavailable", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const client = createServiceNowClient({
      instanceUrl: ORIGIN,
      username: "u",
      password: PASSWORD,
      fetch: fetchMock as unknown as typeof fetch,
    });
    const pending = failure(client.get("incident", query));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ code: "unavailable", retryable: true });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the timeout can be set per client", async () => {
    vi.useFakeTimers();
    const client = createServiceNowClient({
      instanceUrl: ORIGIN,
      username: "u",
      password: PASSWORD,
      timeoutMs: 50,
      fetch: (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    });
    const pending = failure(client.get("incident", query));
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ code: "unavailable" });
  });
});

describe("credentials and the instance origin", () => {
  it("the Authorization header goes only to the configured instance origin", async () => {
    const { client, calls } = setup(() => json({ result: [] }));
    await client.get("incident", query);
    await client.post("incident", {}, ["number"]);
    await client.patch("incident", "0123456789abcdef0123456789abcdef", {});
    for (const call of calls) {
      expect(new URL(call.url).origin).toBe(ORIGIN);
      expect(call.url.startsWith(`${ORIGIN}/api/now/table/`)).toBe(true);
    }
  });

  it.each([
    "http://example.service-now.com",
    "https://example.service-now.com/path",
    "https://example.service-now.com/",
    "https://example.service-now.com:8443",
    "https://user:pw@example.service-now.com",
    "https://example.service-now.com.evil.test",
    "https://evil.test",
    "not a url",
  ])("an instance URL of %s is refused with a config error", (instanceUrl) => {
    let error: unknown;
    try {
      createServiceNowClient({ instanceUrl, username: "u", password: PASSWORD });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "config", retryable: false });
    expect(JSON.stringify([(error as Error).message, { ...(error as object) }])).not.toContain(
      PASSWORD,
    );
  });

  it("an empty password, or a user name with a colon, is a config error", () => {
    for (const [username, password] of [
      ["u", ""],
      ["a:b", PASSWORD],
      ["", PASSWORD],
    ] as const) {
      expect(() =>
        createServiceNowClient({ instanceUrl: ORIGIN, username, password }),
      ).toThrowError(HelpdeskError);
    }
  });

  it("no error, error property or log call holds the password", async () => {
    const sinks = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
      vi.spyOn(process.stdout, "write"),
      vi.spyOn(process.stderr, "write"),
    ];
    const replies: Reply[] = [
      () => new Response("{}", { status: 401 }),
      () => new Response("{}", { status: 403 }),
      () => new Response("{}", { status: 429 }),
      () => new Response("{}", { status: 503 }),
      () => new Response(HIBERNATING),
      () => new Response("plain"),
      () => new Response(null, { status: 302, headers: { location: "https://x.test/" } }),
      () =>
        Promise.reject(new Error(`boom ${PASSWORD} ${Buffer.from(PASSWORD).toString("base64")}`)),
    ];
    const seen: string[] = [];
    for (const reply of replies) {
      const { client } = setup(reply);
      const error = (await failure(client.get("incident", query))) as Error;
      seen.push(
        error.message,
        error.stack ?? "",
        JSON.stringify({ ...error }),
        String((error as { cause?: unknown }).cause ?? ""),
      );
    }
    const logged = sinks.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
    for (const text of [...seen, ...logged]) {
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(Buffer.from(`svc.itsupport:${PASSWORD}`).toString("base64"));
    }
  });
});
