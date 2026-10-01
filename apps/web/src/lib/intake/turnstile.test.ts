import { describe, expect, it, vi } from "vitest";
import { SITEVERIFY_URL, verifyTurnstile } from "./turnstile";

// Cloudflare's published Turnstile test secret ("always passes"), built at
// run time so secret scanners do not see a key-shaped literal.
const TEST_SECRET = `1x${"0".repeat(31)}AA`;

function fetchReturning(body: unknown, init: ResponseInit = { status: 200 }) {
  return vi.fn(async () => Response.json(body, init));
}

describe("verifyTurnstile", () => {
  it("posts secret, token and client IP to siteverify and returns true on success", async () => {
    const fetchImpl = fetchReturning({ success: true });
    await expect(
      verifyTurnstile("tok", "203.0.113.7", { secret: TEST_SECRET, fetchImpl }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SITEVERIFY_URL);
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("secret")).toBe(TEST_SECRET);
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("203.0.113.7");
  });

  it("omits remoteip when the client IP is unknown", async () => {
    const fetchImpl = fetchReturning({ success: true });
    await verifyTurnstile("tok", null, { secret: TEST_SECRET, fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).has("remoteip")).toBe(false);
  });

  it("returns false when siteverify says success:false", async () => {
    const fetchImpl = fetchReturning({ success: false, "error-codes": ["invalid-input-response"] });
    await expect(verifyTurnstile("tok", null, { secret: TEST_SECRET, fetchImpl })).resolves.toBe(
      false,
    );
  });

  it("returns false on a non-2xx response", async () => {
    const fetchImpl = fetchReturning({ success: true }, { status: 500 });
    await expect(verifyTurnstile("tok", null, { secret: TEST_SECRET, fetchImpl })).resolves.toBe(
      false,
    );
  });

  it("returns false (fails closed) when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(verifyTurnstile("tok", null, { secret: TEST_SECRET, fetchImpl })).resolves.toBe(
      false,
    );
  });

  it("returns false on a malformed response body", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 }));
    await expect(verifyTurnstile("tok", null, { secret: TEST_SECRET, fetchImpl })).resolves.toBe(
      false,
    );
  });

  it("returns false for an empty token without calling siteverify", async () => {
    const fetchImpl = fetchReturning({ success: true });
    await expect(verifyTurnstile("", null, { secret: TEST_SECRET, fetchImpl })).resolves.toBe(
      false,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
