import { afterEach, describe, expect, it } from "vitest";
import { createInternalClient, LiveContractError, LiveTransportError } from "./client.ts";
import { loadLiveConfig } from "./config.ts";
import { markerEnv } from "./testing/env.ts";
import {
  startMockE2e,
  type MockE2e,
  type MockReply,
  type MockRequest,
} from "./testing/mock-e2e.ts";

const open: MockE2e[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((mock) => mock.close()));
});

async function setup(override?: (request: MockRequest) => MockReply | undefined) {
  // Credentials first (any origin), then the mock, then the env pointed at it.
  const values = markerEnv("http://127.0.0.1:1");
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    override,
  });
  open.push(mock);
  const env = { ...values, E2E_BASE_URL: mock.origin };
  const config = loadLiveConfig(env);
  return { mock, env, config, client: createInternalClient(config) };
}

describe("createInternalClient", () => {
  it("sends the bearer token and both Access headers, values intact (regex-special characters too)", async () => {
    const { mock, client } = await setup();
    expect((await client.health()).status).toBe("ok");
    expect((await client.healthConfig()).features.internalApi).toBe(true);
    expect((await client.usage("2026-10")).month).toBe("2026-10");
    expect((await client.securityEvents(new Date("2026-10-10T00:00:00Z"))).events).toEqual([]);
    const id = "00000000-0000-4000-8000-000000000002";
    expect((await client.ticket(id)).id).toBe(id);
    expect((await client.createTestTicket({ testId: "t1" })).queued).toBe(true);
    expect(mock.requests).toHaveLength(6);
    for (const request of mock.requests) {
      expect(request.accessOk, request.path).toBe(true);
      expect(request.bearerOk, request.path).toBe(true);
    }
  });

  it("can leave out the token or the Access headers, or send a wrong token", async () => {
    const { mock, client } = await setup();
    expect((await client.send("GET usage", "/api/internal/usage", { token: null })).status).toBe(
      401,
    );
    expect(
      (await client.send("GET usage", "/api/internal/usage", { token: "w".repeat(40) })).status,
    ).toBe(401);
    const denied = await client.send("GET health", "/api/health", { access: false });
    expect(denied.status).toBe(403);
    expect(mock.requests.map((r) => [r.hasBearer, r.bearerOk, r.accessOk])).toEqual([
      [false, false, true],
      [true, false, true],
      [true, true, false],
    ]);
  });

  it("never follows a redirect to a second origin: that origin receives no request", async () => {
    const second = await startMockE2e({ token: "t", accessClientId: "i", accessClientSecret: "s" });
    open.push(second);
    const { client } = await setup((request) =>
      request.path === "/api/health/config"
        ? { status: 302, headers: { Location: `${second.origin}/api/health/config` } }
        : undefined,
    );
    const error = await client.healthConfig().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LiveContractError);
    expect((error as LiveContractError).status).toBe(302);
    // Give a stray follow-up request time to land.
    await new Promise((done) => setTimeout(done, 50));
    expect(second.requests).toEqual([]);
  });

  it("does not follow a same-origin redirect either", async () => {
    const { mock, client } = await setup((request) =>
      request.path === "/api/health"
        ? { status: 307, headers: { Location: "/elsewhere" } }
        : undefined,
    );
    await expect(client.health()).rejects.toThrow(LiveContractError);
    expect(mock.requests.map((r) => r.path)).toEqual(["/api/health"]);
  });

  it("returns a redirect as-is: status and Location readable, nothing followed", async () => {
    const location = "https://team.cloudflareaccess.com/cdn-cgi/access/login/e2e.example.test";
    const { mock, client } = await setup((request) =>
      request.path === "/api/health" ? { status: 302, headers: { Location: location } } : undefined,
    );
    const response = await client.send("GET /api/health", "/api/health");
    expect(response).toMatchObject({ status: 302, location });
    expect(mock.requests.map((r) => r.path)).toEqual(["/api/health"]);
  });

  it("refuses a path that resolves to another origin before sending", async () => {
    const calls: URL[] = [];
    const { config } = await setup();
    const client = createInternalClient(config, {
      fetch: async (input) => {
        calls.push(input);
        return new Response("{}");
      },
    });
    for (const path of [
      "//other.example/x",
      "/\\other.example/x",
      "https://other.example/x",
      "x",
    ]) {
      await expect(client.send("GET x", path)).rejects.toThrow(LiveTransportError);
    }
    expect(calls).toEqual([]);
  });

  it("throws LiveContractError naming the endpoint when the body breaks its schema", async () => {
    const { client } = await setup((request) =>
      request.path === "/api/internal/usage"
        ? { status: 200, json: { month: "2026-10", llm: {}, typesafe: {}, extra: 1 } }
        : request.path === "/api/health/config"
          ? { status: 200, text: "not json" }
          : undefined,
    );
    await expect(client.usage("2026-10")).rejects.toThrow(
      new LiveContractError("GET /api/internal/usage", 200, "schema"),
    );
    await expect(client.healthConfig()).rejects.toThrow(/^GET \/api\/health\/config: /);
  });

  it("never puts a body that echoes the token into an error", async () => {
    const { env, client } = await setup(() => ({
      status: 500,
      json: { error: `bad ${env.INTERNAL_API_TOKEN} ${env.CF_ACCESS_CLIENT_SECRET}` },
    }));
    const error = (await client.usage("2026-10").catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(LiveContractError);
    expect(error.message).toBe("GET /api/internal/usage: unexpected status 500");
    expect(JSON.stringify(error)).not.toContain(env.INTERNAL_API_TOKEN);
  });

  it("turns a fetch error that quotes the URL and credentials into a class name only", async () => {
    const { env, config } = await setup();
    const client = createInternalClient(config, {
      fetch: async () => {
        throw new TypeError(
          `fetch failed for https://u:${env.INTERNAL_API_TOKEN}@${config.host}/ with ${env.CF_ACCESS_CLIENT_SECRET}`,
        );
      },
    });
    const error = (await client.health().catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(LiveTransportError);
    expect(error.message).toBe("GET /api/health: request failed (TypeError)");
    expect(error.cause).toBeUndefined();
  });
});
