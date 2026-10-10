import { afterEach, describe, expect, it } from "vitest";
import { startMockE2e, type MockE2e } from "./testing/mock-e2e.ts";

const open: MockE2e[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((mock) => mock.close()));
});

const token = "t".repeat(40);
const id = "i".repeat(20);
const secret = "s".repeat(30);

async function mock() {
  const started = await startMockE2e({ token, accessClientId: id, accessClientSecret: secret });
  open.push(started);
  return started;
}

const access = { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };

describe("startMockE2e", () => {
  it("refuses a request without the Access headers with a 403 that is not JSON", async () => {
    const m = await mock();
    for (const headers of [
      {},
      { "CF-Access-Client-Id": id },
      { ...access, "CF-Access-Client-Secret": "w".repeat(30) },
    ]) {
      for (const path of ["/", "/api/health", "/api/internal/usage"]) {
        const response = await fetch(new URL(path, m.origin), {
          headers: { ...headers, Authorization: `Bearer ${token}` },
        });
        const text = await response.text();
        expect(response.status, path).toBe(403);
        expect(response.headers.get("content-type")).toMatch(/^text\/html/);
        expect(() => JSON.parse(text)).toThrow();
      }
    }
  });

  it("refuses an internal request without the right bearer token with 401", async () => {
    const m = await mock();
    for (const authorization of [undefined, "Bearer wrong", `Basic ${token}`, `Bearer ${token}x`]) {
      const headers: Record<string, string> = { ...access };
      if (authorization) headers.Authorization = authorization;
      const response = await fetch(new URL("/api/internal/usage?month=2026-10", m.origin), {
        headers,
      });
      expect(response.status, authorization).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("answers the health endpoints behind the gate without a token, and 404 for the unknown", async () => {
    const m = await mock();
    expect((await fetch(new URL("/api/health", m.origin), { headers: access })).status).toBe(200);
    expect((await fetch(new URL("/api/health/config", m.origin), { headers: access })).status).toBe(
      200,
    );
    const auth = { ...access, Authorization: `Bearer ${token}` };
    expect((await fetch(new URL("/nope", m.origin), { headers: auth })).status).toBe(404);
    expect(
      (await fetch(new URL("/api/internal/tickets/not-a-uuid", m.origin), { headers: auth }))
        .status,
    ).toBe(404);
    expect(m.requests.every((r) => !("headers" in r))).toBe(true);
  });

  it("lets an override answer first and records what it saw", async () => {
    const started = await startMockE2e({
      token,
      accessClientId: id,
      accessClientSecret: secret,
      override: (r) => (r.path === "/x" ? { status: 418, text: r.body } : undefined),
    });
    open.push(started);
    const response = await fetch(new URL("/x", started.origin), { method: "POST", body: "hi" });
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("hi");
    expect(started.requests[0]).toMatchObject({
      method: "POST",
      path: "/x",
      accessOk: false,
      hasBearer: false,
    });
  });
});
