import { signSlackRequest } from "@ai-it-support/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInteractivityHandler, MAX_BODY_BYTES, type InteractivityDeps } from "./handler";

const verify = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@ai-it-support/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ai-it-support/shared")>();
  return {
    ...real,
    verifySlackRequest: (input: Parameters<typeof real.verifySlackRequest>[0]) => {
      verify.calls += 1;
      return real.verifySlackRequest(input);
    },
  };
});

// Built at run time: letters and digits only, never a real secret.
const SECRET = ["Secret", "Marker"].join("").repeat(3);
const NOW = 1_800_000_000;
const URL_ = "https://app.example.test/api/slack/interactivity";
const REVIEW_ID = "0b0e3f0c-5d7a-4c1e-9f3a-2b6c8d9e0a1b";
const REVIEWER = "U0A5ATR4WJD";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    type: "block_actions",
    user: { id: REVIEWER },
    channel: { id: "C0000000001" },
    container: { message_ts: "1800000000.000100" },
    response_url: "https://hooks.slack.com/actions/T0/1/abc",
    actions: [{ action_id: "review_approve", value: REVIEW_ID }],
    team: { domain: "body marker" },
    ...overrides,
  };
}

const formBody = (value: unknown) => `payload=${encodeURIComponent(JSON.stringify(value))}`;

function signed(
  body: string,
  opts: { timestamp?: number; signature?: string; type?: string; headers?: object } = {},
) {
  const timestamp = String(opts.timestamp ?? NOW);
  return new Request(URL_, {
    method: "POST",
    body,
    headers: {
      "content-type": opts.type ?? "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": opts.signature ?? signSlackRequest({ secret: SECRET, timestamp, body }),
      ...opts.headers,
    },
  });
}

let deps: InteractivityDeps & {
  recordSecurityEvent: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
};
let logs: string[];
const decided = new Response("decided", { status: 299 });

beforeEach(() => {
  verify.calls = 0;
  logs = [];
  for (const level of ["info", "warn", "error", "log"] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => void logs.push(args.join(" ")));
  }
  deps = {
    signingSecret: SECRET,
    reviewerIds: [REVIEWER, "UE2EREVIEWER"],
    recordSecurityEvent: vi.fn().mockResolvedValue(undefined),
    nowSeconds: () => NOW,
    decide: vi.fn().mockResolvedValue(decided),
  };
});
afterEach(() => vi.restoreAllMocks());

const run = (request: Request) => createInteractivityHandler(deps)(request);

async function expectRefusal(res: Response, status: number, error: string, kind: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(deps.recordSecurityEvent).toHaveBeenCalledTimes(1);
  expect(deps.recordSecurityEvent).toHaveBeenCalledWith("slack", kind, {
    path: "/api/slack/interactivity",
    method: "POST",
  });
  expect(Object.keys(deps.recordSecurityEvent.mock.calls[0][2])).toEqual(["path", "method"]);
  expect(deps.decide).not.toHaveBeenCalled();
}

describe("createInteractivityHandler", () => {
  it("T4.S.01: a valid signed approve calls decide once and returns its response unchanged", async () => {
    const res = await run(signed(formBody(payload())));
    expect(res).toBe(decided);
    expect(deps.decide).toHaveBeenCalledTimes(1);
    expect(deps.decide).toHaveBeenCalledWith(
      {
        decision: "approve",
        reviewId: REVIEW_ID,
        userId: REVIEWER,
        channelId: "C0000000001",
        messageTs: "1800000000.000100",
        responseUrl: "https://hooks.slack.com/actions/T0/1/abc",
      },
      { path: "/api/slack/interactivity", method: "POST" },
    );
    expect(deps.recordSecurityEvent).not.toHaveBeenCalled();
  });

  it("answers the three signature failures with the same 401 status, body and headers", async () => {
    const body = formBody(payload());
    const missing = new Request(URL_, { method: "POST", body });
    const cases = [
      [missing, "missing_signature"],
      [signed(body, { signature: `v0=${"0".repeat(64)}` }), "bad_signature"],
      [signed(body, { timestamp: NOW - 301 }), "stale_timestamp"],
    ] as const;
    const seen: string[] = [];
    for (const [request, kind] of cases) {
      deps.recordSecurityEvent.mockClear();
      const res = await run(request);
      seen.push(JSON.stringify([...res.headers]));
      await expectRefusal(res, 401, "unauthorized", kind);
    }
    expect(new Set(seen).size).toBe(1);
  });

  it("refuses an unknown action and a JSON content type with 400 bad_payload", async () => {
    const unknown = payload({ actions: [{ action_id: "review_maybe", value: REVIEW_ID }] });
    await expectRefusal(await run(signed(formBody(unknown))), 400, "bad_payload", "bad_payload");
    deps.recordSecurityEvent.mockClear();
    const asJson = signed(JSON.stringify(payload()), { type: "application/json" });
    await expectRefusal(await run(asJson), 400, "bad_payload", "bad_payload");
  });

  it("refuses a reviewer outside SLACK_REVIEWER_IDS with 403 forbidden", async () => {
    const res = await run(signed(formBody(payload({ user: { id: "U0000000099" } }))));
    await expectRefusal(res, 403, "forbidden", "not_allow_listed");
  });

  it("refuses 128 KB + 1 byte with 413 before the verifier, by header or by stream", async () => {
    const big = "a".repeat(MAX_BODY_BYTES + 1);
    const declared = signed(big, { headers: { "content-length": String(big.length) } });
    await expectRefusal(await run(declared), 413, "too_large", "body_too_large");
    deps.recordSecurityEvent.mockClear();
    const half = "a".repeat(MAX_BODY_BYTES / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of [half, half, "a"]) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });
    const streamed = new Request(URL_, { method: "POST", body: stream, duplex: "half" } as never);
    await expectRefusal(await run(streamed), 413, "too_large", "body_too_large");
    expect(verify.calls).toBe(0);
  });

  it("refuses a declared content-length over 128 KB at once, whatever the body", async () => {
    const request = signed("a", { headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
    await expectRefusal(await run(request), 413, "too_large", "body_too_large");
    expect(verify.calls).toBe(0);
  });

  it("passes a body of exactly 128 KB on to the verifier", async () => {
    const body = "a".repeat(MAX_BODY_BYTES);
    const res = await run(signed(body, { headers: { "content-length": String(body.length) } }));
    expect(verify.calls).toBe(1);
    expect(res.status).toBe(400);
  });

  it("runs the HMAC on the raw text: a body re-encoded after signing (%20 → +) is 401", async () => {
    const body = formBody(payload());
    expect(body).toContain("%20");
    const request = signed(body.replaceAll("%20", "+"), {
      signature: signSlackRequest({ secret: SECRET, timestamp: String(NOW), body }),
    });
    await expectRefusal(await run(request), 401, "unauthorized", "bad_signature");
  });

  it("still returns the refusal when recording fails, logging the error class only", async () => {
    deps.recordSecurityEvent.mockRejectedValue(new RangeError("db down marker-db"));
    const res = await run(new Request(URL_, { method: "POST", body: "x" }));
    expect(res.status).toBe(401);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({
      level: "error",
      scope: "slack-interactivity",
      msg: "security event lost",
      kind: "missing_signature",
      error: "RangeError",
    });
  });

  it("answers 500 internal_error when decide throws, logging the error class only", async () => {
    deps.decide.mockRejectedValue(new TypeError("boom marker-decide"));
    const res = await run(signed(formBody(payload())));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        level: "error",
        scope: "slack-interactivity",
        msg: "interaction failed",
        error: "TypeError",
      },
    ]);
    expect(logs.map((line) => JSON.parse(line).error)).toEqual(["TypeError"]);
  });

  it("logs the class name `unknown` for a thrown non-error", async () => {
    deps.decide.mockRejectedValue("plain");
    await run(signed(formBody(payload())));
    expect(JSON.parse(logs[0]).error).toBe("unknown");
  });

  it("never puts the secret, the body or the signature in a log line or a response", async () => {
    const SIGNATURE = `v0=${"5161".repeat(16)}`;
    deps.recordSecurityEvent.mockRejectedValue(new Error("write failed"));
    const requests = [
      signed(formBody(payload())),
      signed(formBody(payload()), { signature: SIGNATURE }),
      signed(formBody(payload({ user: { id: "U0000000099" } }))),
      signed(formBody(payload({ type: "body marker" }))),
    ];
    deps.decide.mockRejectedValue(new Error(`${SECRET} body marker ${SIGNATURE}`));
    const seen: string[] = [];
    for (const request of requests) {
      const res = await run(request);
      seen.push(await res.text(), JSON.stringify([...res.headers]));
    }
    const all = [...seen, ...logs].join("\n");
    for (const marker of [SECRET, "body marker", "body%20marker", SIGNATURE]) {
      expect(all).not.toContain(marker);
    }
  });
});
