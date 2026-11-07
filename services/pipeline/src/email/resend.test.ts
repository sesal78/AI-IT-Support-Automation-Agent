import { describe, expect, it, vi } from "vitest";
import { createResendClient, EmailProviderError, type SendEmailInput } from "./resend.js";

// Built from pieces so no key-shaped literal sits in the source.
const KEY = ["re", "KEYMARKER0123456789abc"].join("_");
const BODY_MARKER = "BODYMARKER-5521";
const input: SendEmailInput = {
  from: "help@example.com",
  to: "Carol@Example.com",
  subject: "Your IT ticket ITS-000042",
  text: `text ${BODY_MARKER}`,
  html: `<p>${BODY_MARKER}</p>`,
  idempotencyKey: "notify:0b6c8f1e-1111-4222-8333-444455556666:incident_reply",
};

type Reply = Response | Error | "hang";
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function setup(replies: Reply[], extra: { timeoutMs?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const reply = replies.shift() ?? new Error("no scripted reply");
    if (reply === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error(`aborted ${KEY}`)));
      });
    }
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const client = createResendClient({
    apiKey: KEY,
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep,
    ...extra,
  });
  return { client, calls, sleeps };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("createResendClient", () => {
  it("200 { id } sends one request with the URL, headers and JSON body", async () => {
    const { client, calls } = setup([json(200, { id: "msg_123" })]);
    expect(await client.send(input)).toEqual({ id: "msg_123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers["Idempotency-Key"]).toBe(input.idempotencyKey);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      from: "help@example.com",
      to: ["carol@example.com"],
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
  });

  it("429 with Retry-After: 2 then 200 sends 2 requests and sleeps 2000 ms", async () => {
    const { client, calls, sleeps } = setup([
      json(429, {}, { "retry-after": "2" }),
      json(200, { id: "msg_1" }),
    ]);
    await client.send(input);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("caps Retry-After at 30 s and floors a bad value at 1 s", async () => {
    const a = setup([json(429, {}, { "retry-after": "999" }), json(200, { id: "m" })]);
    await a.client.send(input);
    expect(a.sleeps).toEqual([30_000]);
    const b = setup([json(429, {}, { "retry-after": "soon" }), json(200, { id: "m" })]);
    await b.client.send(input);
    expect(b.sleeps).toEqual([1000]);
  });

  it("three 500s throw http_500 after 3 requests, sleeping 1 s then 2 s", async () => {
    const { client, calls, sleeps } = setup([json(500, {}), json(500, {}), json(500, {})]);
    const error = (await caught(client.send(input))) as EmailProviderError;
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.code).toBe("http_500");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("422 throws http_422 after 1 request", async () => {
    const { client, calls } = setup([json(422, { message: BODY_MARKER })]);
    const error = (await caught(client.send(input))) as EmailProviderError;
    expect(error.code).toBe("http_422");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["no id", json(200, {})],
    ["a non-string id", json(200, { id: 5 })],
    ["null JSON", json(200, null)],
    ["bad JSON", new Response("not json", { status: 200 })],
  ])("%s throws bad_response", async (_name, reply) => {
    const { client, calls } = setup([reply]);
    expect(((await caught(client.send(input))) as EmailProviderError).code).toBe("bad_response");
    expect(calls).toHaveLength(1);
  });

  it("a redirect fails without a retry", async () => {
    const { client, calls } = setup([json(302, {}, { location: "https://evil.example" })]);
    expect(((await caught(client.send(input))) as EmailProviderError).code).toBe("redirect");
    expect(calls).toHaveLength(1);
  });

  it("a network error is retried, then recovers", async () => {
    const { client, calls, sleeps } = setup([new Error(`boom ${KEY}`), json(200, { id: "msg_2" })]);
    expect(await client.send(input)).toEqual({ id: "msg_2" });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("a network error three times throws network", async () => {
    const { client, calls } = setup([new Error("a"), new Error("b"), new Error("c")]);
    expect(((await caught(client.send(input))) as EmailProviderError).code).toBe("network");
    expect(calls).toHaveLength(3);
  });

  it("a timeout is retried and ends as timeout", async () => {
    const { client, calls } = setup(["hang", "hang", "hang"], { timeoutMs: 5 });
    expect(((await caught(client.send(input))) as EmailProviderError).code).toBe("timeout");
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["to", { to: "carol@example.com\r\nBcc: x@y.com" }],
    ["from", { from: "help@example.com\r\nBcc: x@y.com" }],
    ["subject", { subject: "Hi\r\nBcc: x@y.com" }],
    ["idempotencyKey", { idempotencyKey: "k\r\nBcc: x@y.com" }],
  ])("T5.U.04: an unsafe %s throws before any request", async (field, patch) => {
    const { client, calls } = setup([json(200, { id: "x" })]);
    const error = (await caught(client.send({ ...input, ...patch }))) as Error;
    expect(error.name).toBe("EmailHeaderError");
    expect(error.message).toContain(field);
    expect(calls).toHaveLength(0);
  });

  it("rejects an odd idempotency key and a bad API key before any request", async () => {
    const { client, calls } = setup([]);
    await expect(client.send({ ...input, idempotencyKey: "has space" })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
    expect(() => createResendClient({ apiKey: "nope" })).toThrow(TypeError);
  });

  it("leaks neither the API key nor the body in any error, property or logger call", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    const scenarios: Reply[][] = [
      [json(422, { message: `${KEY} ${BODY_MARKER}` })],
      [new Error(`${KEY} ${BODY_MARKER}`), new Error(KEY), new Error(BODY_MARKER)],
      [json(500, KEY), json(500, KEY), json(500, KEY)],
      [new Response(`${KEY} ${BODY_MARKER}`, { status: 200 })],
    ];
    for (const replies of scenarios) {
      const error = (await caught(setup(replies).client.send(input))) as EmailProviderError;
      const dump = JSON.stringify({ ...error, message: error.message, stack: error.stack });
      expect(dump).not.toContain(KEY);
      expect(dump).not.toContain(BODY_MARKER);
      expect(error.cause).toBeUndefined();
    }
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(BODY_MARKER);
      spy.mockRestore();
    }
  });
});
