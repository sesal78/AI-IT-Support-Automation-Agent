import { canaryTicketText, findCanaries } from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";
import { buildReplyEmail, type ReplyEmailInput } from "./template.js";

const base: ReplyEmailInput = {
  kind: "incident_reply",
  ticketNumber: "ITS-000042",
  number: "INC0010001",
  fixSteps: ["Restart the printer", "Check the cable", "Reinstall the driver"],
};

describe("buildReplyEmail incident_reply", () => {
  it("gives the subject, both numbers in both bodies and the numbered steps", () => {
    const mail = buildReplyEmail(base);
    expect(mail.subject).toBe("Your IT ticket ITS-000042");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("Your ticket number is ITS-000042.");
      expect(body).toContain("Helpdesk reference: INC0010001.");
    }
    expect(mail.text).toContain(
      "1. Restart the printer\n2. Check the cable\n3. Reinstall the driver",
    );
    expect(mail.html).toContain(
      "<ol><li>Restart the printer</li><li>Check the cable</li><li>Reinstall the driver</li></ol>",
    );
  });

  it("prefixes the subject of a test ticket", () => {
    expect(buildReplyEmail({ ...base, isTest: true }).subject).toBe(
      "[E2E] Your IT ticket ITS-000042",
    );
  });

  it.each(["ITS-42", "ITS-000042\r\n", "its-000042", ""])("rejects ticket number %j", (value) => {
    expect(() => buildReplyEmail({ ...base, ticketNumber: value })).toThrow(TypeError);
  });

  it.each(["INC0010001\r\nX: 1", "INC001", "HD123", "", "ITS-000042"])(
    "rejects helpdesk number %j",
    (value) => {
      expect(() => buildReplyEmail({ ...base, number: value })).toThrow(TypeError);
    },
  );

  it("accepts a built-in HD number", () => {
    expect(buildReplyEmail({ ...base, number: "HD0000001" }).text).toContain("HD0000001");
  });

  it("shows the first 8 of 10 steps", () => {
    const fixSteps = Array.from({ length: 10 }, (_, i) => `step-${i + 1}`);
    const mail = buildReplyEmail({ ...base, fixSteps });
    expect(mail.text).toContain("8. step-8");
    expect(mail.text).not.toContain("step-9");
    expect(mail.html).not.toContain("step-9");
  });

  it("T5.U.04: escapes HTML in html and leaves text unchanged", () => {
    const mail = buildReplyEmail({
      ...base,
      fixSteps: ["<script>alert(1)</script>", `a & "b" 'c'`],
    });
    expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(mail.html).toContain("a &amp; &quot;b&quot; &#39;c&#39;");
    expect(mail.html).not.toContain("<script>");
    expect(mail.text).toContain("1. <script>alert(1)</script>");
  });

  it("T5.U.04: a step with CR/LF cannot add lines or headers", () => {
    const mail = buildReplyEmail({ ...base, fixSteps: ["Restart\r\nBcc: x@y.com"] });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain("1. Restart Bcc: [REDACTED_EMAIL]");
    expect(mail.text).not.toMatch(/\r/);
  });

  it("redacts a canary step in both bodies", () => {
    const runId = "abcd1234";
    const mail = buildReplyEmail({ ...base, fixSteps: [canaryTicketText(runId)] });
    for (const body of [mail.subject, mail.text, mail.html]) {
      expect(findCanaries(body, runId)).toEqual([]);
    }
    expect(mail.text).toContain("[REDACTED_");
  });

  it.each([
    ["a phone split by newlines", "call 0412\n345\n678", "0412 345 678"],
    ["a card split by newlines", "4111\n1111\n1111\n1111", "4111 1111 1111 1111"],
    ["a TFN split by newlines", "TFN 123\n456\n782", "123 456 782"],
    ["a +61 phone split by newlines", "+61\n491\n570\n156", "+61 491 570 156"],
  ])("redacts %s in both bodies, never the digits", (_name, step, joined) => {
    const mail = buildReplyEmail({ ...base, fixSteps: [step] });
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("[REDACTED_");
      expect(body).not.toContain(joined);
      expect(body).not.toMatch(/0412|4111|123 456|491 570/);
    }
  });

  it("throws TypeError when no non-empty step remains", () => {
    for (const fixSteps of [[], ["", "   ", "\n\t"]]) {
      expect(() => buildReplyEmail({ ...base, fixSteps })).toThrow(TypeError);
    }
  });

  it("drops empty steps and still shows the first 8 of the rest", () => {
    const fixSteps = ["", ...Array.from({ length: 9 }, (_, i) => `s${i + 1}`)];
    const mail = buildReplyEmail({ ...base, fixSteps });
    expect(mail.text).toContain("1. s1");
    expect(mail.text).toContain("8. s8");
    expect(mail.text).not.toContain("s9");
  });

  it("rejects a bad kind, a non-list of steps and a non-string step", () => {
    expect(() => buildReplyEmail({ ...base, kind: "other" as never })).toThrow(TypeError);
    expect(() => buildReplyEmail({ ...base, fixSteps: undefined })).toThrow(TypeError);
    expect(() => buildReplyEmail({ ...base, fixSteps: [1 as never] })).toThrow(TypeError);
  });
});

describe("buildReplyEmail needs_info", () => {
  const input: ReplyEmailInput = { kind: "needs_info", ticketNumber: "ITS-000042" };

  it("gives the subject, the checklist and no helpdesk number", () => {
    const mail = buildReplyEmail(input);
    expect(mail.subject).toBe("More detail needed for your IT ticket ITS-000042");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("Your ticket number is ITS-000042.");
      expect(body).toContain("The exact error message");
      expect(body).not.toContain("Helpdesk reference");
    }
    expect(mail.text).toContain("4. Which device or app it affects");
  });

  it("ignores a helpdesk number and prefixes a test ticket", () => {
    const mail = buildReplyEmail({ ...input, number: "INC0010001", isTest: true });
    expect(mail.subject).toBe("[E2E] More detail needed for your IT ticket ITS-000042");
    expect(mail.text + mail.html).not.toContain("INC0010001");
  });

  it("is pure: the same input gives a deep-equal result", () => {
    expect(buildReplyEmail(input)).toEqual(buildReplyEmail(input));
    expect(buildReplyEmail(base)).toEqual(buildReplyEmail(base));
  });

  it("rejects a bad ticket number", () => {
    expect(() => buildReplyEmail({ ...input, ticketNumber: "ITS-42" })).toThrow(TypeError);
  });
});

describe("buildReplyEmail leakage", () => {
  it("never outputs extra input keys", () => {
    const marker = "MARKER-7f3a9c";
    for (const kind of ["incident_reply", "needs_info"] as const) {
      const mail = buildReplyEmail({
        ...base,
        kind,
        requesterName: `Name ${marker}`,
        rawDescription: `Raw ${marker}`,
      } as ReplyEmailInput);
      expect(JSON.stringify(mail)).not.toContain(marker);
    }
  });
});
