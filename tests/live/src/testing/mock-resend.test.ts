// The fetch-level Resend mock, driven directly: it builds the reply email the
// app's template would build, answers one method only, and follows the clock.
import { describe, expect, it } from "vitest";
import {
  DELIVERED_AFTER_MS,
  mockResend,
  RESEND_READ_KEY,
  RESEND_URL,
  TEST_REPLY_RECIPIENT,
} from "./mock-resend.ts";

const DRAFT = {
  to: TEST_REPLY_RECIPIENT,
  ticketNumber: "ITS-000042",
  incidentNumber: "INC0010001",
  kind: "incident_reply" as const,
  steps: ["Restart the printer.", "Ask IT to check the queue."],
};

const read = (id: string) => new URL(`/emails/${id}`, RESEND_URL);
const headers = { Authorization: `Bearer ${RESEND_READ_KEY}`, Accept: "application/json" };

describe("mockResend", () => {
  it("builds the incident reply: both numbers in the subject and in both bodies", async () => {
    const resend = mockResend({ now: () => 0 });
    const id = resend.send(DRAFT);
    const email = (await (await resend.fetch(read(id), { headers })).json()) as Record<
      string,
      unknown
    >;
    expect(email).toMatchObject({
      to: [TEST_REPLY_RECIPIENT],
      subject: "[E2E] Your IT ticket ITS-000042",
      last_event: "sent",
    });
    for (const body of [email["text"], email["html"]]) {
      expect(String(body)).toContain("ITS-000042");
      expect(String(body)).toContain("INC0010001");
      expect(String(body)).toContain("Restart the printer.");
    }
  });

  it("builds the needs_info variant, whose subject names the details, without a helpdesk number", async () => {
    const resend = mockResend({ now: () => 0 });
    const id = resend.send({ ...DRAFT, kind: "needs_info" });
    const email = (await (await resend.fetch(read(id), { headers })).json()) as Record<
      string,
      unknown
    >;
    expect(email["subject"]).toBe("[E2E] More detail needed for your IT ticket ITS-000042");
    expect(String(email["text"])).toContain("The exact error message, if there was one");
    expect(String(email["text"])).not.toContain("INC0010001");
  });

  it("answers GET only, on the read path, with the read key", async () => {
    const resend = mockResend({ now: () => 0 });
    const id = resend.send(DRAFT);
    expect((await resend.fetch(read(id), { method: "POST", headers })).status).toBe(404);
    expect((await resend.fetch(read(id), {})).status).toBe(401);
    expect((await resend.fetch(read("em_404"), { headers })).status).toBe(404);
    expect((await resend.fetch(new URL("/emails", RESEND_URL), { headers })).status).toBe(404);
    expect((await resend.fetch(read(id), { headers })).status).toBe(200);
    expect(resend.methods()).toEqual(["POST", "GET", "GET", "GET", "GET"]);
  });

  it("moves last_event to delivered after the delivery time", async () => {
    let now = 0;
    const resend = mockResend({ now: () => now });
    const id = resend.send(DRAFT);
    const event = async () =>
      ((await (await resend.fetch(read(id), { headers })).json()) as Record<string, unknown>)[
        "last_event"
      ];
    expect(await event()).toBe("sent");
    now = DELIVERED_AFTER_MS;
    expect(await event()).toBe("delivered");
  });

  it("applies the faults: a pinned event and changed subject, text and html", async () => {
    const resend = mockResend({
      now: () => 0,
      lastEvent: () => "bounced",
      subject: (_draft, subject) => subject.replace("ITS-000042", ""),
      text: (_draft, text) => `${text}\nSSN 078-05-1120`,
      html: (_draft, html) => `${html}<p>SSN 078-05-1120</p>`,
    });
    const id = resend.send(DRAFT);
    const email = (await (await resend.fetch(read(id), { headers })).json()) as Record<
      string,
      unknown
    >;
    expect(email["last_event"]).toBe("bounced");
    expect(email["subject"]).toBe("[E2E] Your IT ticket ");
    expect(String(email["text"])).toContain("078-05-1120");
    expect(String(email["html"])).toContain("078-05-1120");
  });
});
