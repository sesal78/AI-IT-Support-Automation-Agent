import { describe, expect, it } from "vitest";
import type { ResendConfig } from "./config.ts";
import { createE2eResend, RESEND_API_ORIGIN, ResendApiError, ResendGuardError } from "./resend.ts";
import { mockResend, RESEND_READ_KEY, TEST_REPLY_RECIPIENT } from "./testing/mock-resend.ts";

const config: ResendConfig = { readKey: RESEND_READ_KEY, replyRecipient: TEST_REPLY_RECIPIENT };
const DRAFT = {
  to: TEST_REPLY_RECIPIENT,
  ticketNumber: "ITS-000042",
  incidentNumber: "INC0010001",
  kind: "incident_reply" as const,
  steps: ["Restart the printer.", "Ask IT to check the queue."],
};

/** A mock with one incident reply already sent. */
function sent(options: Parameters<typeof mockResend>[0] = { now: () => 0 }) {
  const resend = mockResend(options);
  const id = resend.send(DRAFT);
  return { resend, id };
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return `${(error as Error).name} ${(error as Error).message} ${(error as Error).stack ?? ""}`;
  }
  throw new Error("expected a rejection");
}

describe("createE2eResend", () => {
  it("refuses an unset read key before any request", async () => {
    const resend = mockResend({ now: () => 0 });
    const helper = createE2eResend({ ...config, readKey: undefined }, resend.fetch);
    await expect(helper.getEmail("em_1")).rejects.toMatchObject({ reason: "config_missing" });
    expect(resend.requests).toEqual([]);
  });

  it.each(["", " ", "em 1", "a/b", "../x", "..", "a?b", "a#b", "x".repeat(65), "em%2F1"])(
    "refuses the id %j before any request",
    async (id) => {
      const resend = mockResend({ now: () => 0 });
      const helper = createE2eResend(config, resend.fetch);
      await expect(helper.getEmail(id)).rejects.toBeInstanceOf(ResendGuardError);
      await expect(helper.getEmail(id)).rejects.toMatchObject({ reason: "bad_argument" });
      expect(resend.requests).toEqual([]);
    },
  );

  it("reads the five fields with one GET to the fixed origin", async () => {
    const { resend, id } = sent();
    const email = await createE2eResend(config, resend.fetch).getEmail(id);
    expect(email).toEqual({
      lastEvent: "sent",
      to: [TEST_REPLY_RECIPIENT],
      subject: "[E2E] Your IT ticket ITS-000042",
      html: expect.stringContaining("INC0010001"),
      text: expect.stringContaining("INC0010001"),
    });
    expect(resend.requests).toHaveLength(1);
    const request = resend.requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url.origin).toBe(RESEND_API_ORIGIN);
    expect(request.url.pathname).toBe(`/emails/${id}`);
  });

  it("sends only GET: the read key travels in one Authorization header, redirects are manual", async () => {
    const seen: Array<{ method: string; headers: Headers; redirect: string | undefined }> = [];
    const { resend, id } = sent();
    const helper = createE2eResend(config, async (input, init) => {
      seen.push({
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        redirect: init.redirect,
      });
      return resend.fetch(input, init);
    });
    await helper.getEmail(id);
    await helper.getEmail(id);
    expect(seen.map((request) => request.method)).toEqual(["GET", "GET"]);
    expect(seen[0]!.headers.get("Authorization")).toBe(`Bearer ${RESEND_READ_KEY}`);
    expect(seen[0]!.headers.get("Accept")).toBe("application/json");
    expect(seen.every((request) => request.redirect === "manual")).toBe(true);
    expect(resend.methods()).toEqual(["GET", "GET"]);
  });

  it("reports a message as delivered once the clock passes the delivery time", async () => {
    let now = 0;
    const { resend, id } = sent({ now: () => now, deliveredAfterMs: () => 1_000 });
    const helper = createE2eResend(config, resend.fetch);
    expect((await helper.getEmail(id)).lastEvent).toBe("sent");
    now = 1_000;
    expect((await helper.getEmail(id)).lastEvent).toBe("delivered");
  });

  it("returns text: null when the message has no text part, and never crashes", async () => {
    const helper = createE2eResend(config, async () =>
      Response.json({
        to: [TEST_REPLY_RECIPIENT],
        subject: "s",
        html: "<p>h</p>",
        text: null,
        last_event: "delivered",
      }),
    );
    expect((await helper.getEmail("em_1")).text).toBeNull();
  });

  it.each([
    ["a 500", 500],
    ["a redirect", 302],
    ["a 404", 404],
  ])("reports %s as an API error naming the status only", async (_case, status) => {
    const helper = createE2eResend(
      config,
      async () =>
        new Response(null, {
          status,
          headers: status === 302 ? { Location: "https://evil.example/x" } : {},
        }),
    );
    const message = await messageOf(helper.getEmail("em_1"));
    expect(message).toContain("ResendApiError");
    expect(message).toContain(`status ${status}`);
    await expect(helper.getEmail("em_1")).rejects.toBeInstanceOf(ResendApiError);
  });

  it("never follows a redirect: one request, and the key stays on the fixed origin", async () => {
    const urls: string[] = [];
    const helper = createE2eResend(config, async (input) => {
      urls.push(input.origin);
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/x" } });
    });
    await expect(helper.getEmail("em_1")).rejects.toBeInstanceOf(ResendApiError);
    expect(urls).toEqual([RESEND_API_ORIGIN]);
  });

  it.each([
    ["a transport failure", async () => Promise.reject(new Error("socket closed"))],
    ["a body that is not JSON", async () => new Response("not json", { status: 200 })],
    [
      "a body without last_event",
      async () => Response.json({ to: [TEST_REPLY_RECIPIENT], subject: "s", html: "h", text: "t" }),
    ],
    [
      "a body without text",
      async () =>
        Response.json({ to: [TEST_REPLY_RECIPIENT], subject: "s", html: "h", last_event: "sent" }),
    ],
    [
      "an empty recipient list",
      async () => Response.json({ to: [], subject: "s", html: "h", text: "t", last_event: "sent" }),
    ],
    [
      "a malformed last_event",
      async () =>
        Response.json({
          to: [TEST_REPLY_RECIPIENT],
          subject: "s",
          html: "h",
          text: "t",
          last_event: "NOT AN EVENT",
        }),
    ],
  ])("reports %s as a bad response, never as an email", async (_case, impl) => {
    const helper = createE2eResend(config, impl);
    const error = await helper.getEmail("em_1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResendApiError);
    expect((error as ResendApiError).status).toBe(0);
  });

  it("with the read key set to a marker, no error, stack or request URL holds it", async () => {
    const echoing = async (_input: URL, init: RequestInit) =>
      new Response(JSON.stringify({ error: { message: `${RESEND_READ_KEY}` } }), {
        status: 500,
        statusText: RESEND_READ_KEY,
        headers: { "x-echo": String(init.headers) },
      });
    const garbled = async () => new Response(`${RESEND_READ_KEY} not json`, { status: 200 });
    const failing = async () => {
      throw new Error(`socket ${RESEND_READ_KEY}`);
    };
    const wrongShape = async () => new Response(JSON.stringify({ last_event: RESEND_READ_KEY }));
    for (const impl of [echoing, garbled, failing, wrongShape]) {
      const helper = createE2eResend(config, impl);
      const text = await messageOf(helper.getEmail("em_1"));
      expect(text).not.toContain(RESEND_READ_KEY);
    }
    const { resend, id } = sent();
    await createE2eResend(config, resend.fetch).getEmail(id);
    expect(resend.requests.map((request) => request.url.href).join("\n")).not.toContain(
      RESEND_READ_KEY,
    );
  });

  it("refuses a wrong read key with the mock's 401, naming the status only", async () => {
    const { resend, id } = sent();
    const wrongKey = ["re", "WrongKey".padEnd(24, "x")].join("_");
    const helper = createE2eResend({ ...config, readKey: wrongKey }, resend.fetch);
    const error = await helper.getEmail(id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResendApiError);
    expect((error as ResendApiError).status).toBe(401);
    expect((error as Error).message).toBe("getEmail: status 401");
  });
});
