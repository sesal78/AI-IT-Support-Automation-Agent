// T5.L.06 (P5-T8c) through runLive, against the mocks only: the positive case,
// and every acceptance negative with the check it must name.
import { describe, expect, it, afterEach } from "vitest";
import { replyEmailScenario } from "./helpdesk-reply.ts";
import { startHelpdeskHarness, type HelpdeskHarness } from "./testing/helpdesk-harness.ts";

const harnesses: HelpdeskHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});
async function harness(options: Parameters<typeof startHelpdeskHarness>[0] = {}) {
  const h = await startHelpdeskHarness(options);
  harnesses.push(h);
  return h;
}

const evidenceOf = (report: { scenarios: readonly { evidence: Record<string, unknown> }[] }) =>
  report.scenarios[0]!.evidence;
const failedChecks = (report: { scenarios: readonly { evidence: Record<string, unknown> }[] }) =>
  evidenceOf(report)["failedChecks"] as string[];

describe("T5.L.06 the reply email", () => {
  it("passes with a sent incident reply, delivered, both numbers in both bodies and no canary", async () => {
    const h = await harness();
    const { code, report, text } = await h.run([], [replyEmailScenario]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      status: "incident_created",
      route: "auto",
      notificationKind: "incident_reply",
      notificationStatus: "sent",
      deliveredMs: 20_000,
      canaryHits: 0,
      subjectNumber: true,
      textNumbers: true,
      htmlNumbers: true,
      j1Score: 0.8,
      j4Score: 0.8,
      aiCallCount: 1,
      cleanupClosed: 1,
      cleanupOpen: 0,
      failedChecks: [],
    });
    expect(evidenceOf(report)["incidentNumber"]).toBe("INC0000001");
    expect(evidenceOf(report)["ticketNumber"]).toMatch(/^ITS-[0-9]{6}$/);
    // One ticket, one email read path, and only GET ever reached the provider.
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(1);
    expect(h.resendMethods().length).toBeGreaterThan(0);
    expect(h.resendMethods().every((method) => method === "GET")).toBe(true);
    expect(h.judgeIds()).toEqual(["J1", "J4"]);
    // The incident is closed, and no ticket text or canary is in the report.
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
    expect(text).not.toContain("paper jam");
    expect(text).not.toContain("boarding passes");
    expect(text).not.toContain("078-05-1120");
  });

  it("signs an approve and goes on when the canary text routes the ticket to review", async () => {
    const h = await harness({ faults: { route: () => "review" } });
    const { code, report } = await h.run([], [replyEmailScenario]);
    expect(code).toBe(0);
    expect(evidenceOf(report)).toMatchObject({
      route: "review",
      status: "incident_created",
      notificationStatus: "sent",
      failedChecks: [],
    });
    expect(h.count("POST", "/api/slack/interactivity")).toBe(1);
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
  });

  it.each([
    [
      "the email is not delivered at the limit",
      { deliveredAfterMs: () => 121_000 },
      "email-delivered-within-120s",
    ],
    [
      "the number is missing from the subject",
      {
        subject: (draft: { ticketNumber: string }, subject: string) =>
          subject.replace(draft.ticketNumber, "your ticket"),
      },
      "subject-ticket-number",
    ],
  ] as const)("fails, naming the check, when %s", async (_case, resend, check) => {
    const h = await harness({ resend });
    const { code, report } = await h.run([], [replyEmailScenario]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toContain(check);
    // Cleanup still ran, whatever the finding.
    expect(evidenceOf(report)["cleanupOpen"]).toBe(0);
    expect(h.data.incidents.every((i) => i["state"] === "7")).toBe(true);
  });

  it("fails, naming the check, when a canary is in the html, and makes no judge call", async () => {
    const h = await harness({
      resend: { html: (_draft, html) => `${html}<p>SSN 078-05-1120</p>` },
    });
    const { code, report } = await h.run([], [replyEmailScenario]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toContain("no-canaries");
    expect(evidenceOf(report)["canaryHits"]).toBe(1);
    expect(h.judgeIds()).toEqual([]);
  });

  it.each([
    ["J1", 0.69],
    ["J4", 0.69],
  ] as const)("fails when %s scores %s", async (judgeId, score) => {
    const h = await harness({ judge: (id) => (id === judgeId ? score : 0.8) });
    const { code, report } = await h.run([], [replyEmailScenario]);
    expect(code).toBe(1);
    expect(failedChecks(report)).toEqual([`${judgeId.toLowerCase()}-score`]);
    expect(evidenceOf(report)[`${judgeId.toLowerCase()}Score`]).toBe(score);
  });

  it("is not_run, with no request, when the reply-email variables are unset", async () => {
    const h = await harness({ withResend: false });
    const { code, report } = await h.run([], [replyEmailScenario]);
    expect(code).toBe(2);
    expect(report.scenarios[0]).toMatchObject({ status: "not_run" });
    expect(h.count("POST", "/api/internal/test-tickets")).toBe(0);
    expect(h.resendMethods()).toEqual([]);
  });
});
