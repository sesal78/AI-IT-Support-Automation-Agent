// The mock phase 5 flow, driven directly (no HTTP): each step lands at its own
// time, the incident is a real Table API row, and the faults show the negative
// cases the scenarios use.
import { beforeEach, describe, expect, it } from "vitest";
import type { MockRequest } from "./mock-e2e.ts";
import { createMockHelpdesk, type MockHelpdesk } from "./mock-helpdesk.ts";
import { fullInstance, type MockSnData } from "./mock-servicenow.ts";

const T0 = Date.parse("2026-11-13T00:00:00Z");
const PRINTER = {
  title: "Printer on level 2 is offline",
  description: "The printer shows a paper jam and will not print.",
};

let now = T0;
let data: MockSnData;
let helpdesk: MockHelpdesk;

beforeEach(() => {
  now = T0;
  data = fullInstance();
  helpdesk = createMockHelpdesk({ now: () => now, data });
});

function request(path: string, body: unknown = {}): MockRequest {
  return {
    method: path.startsWith("/api/internal/tickets/") ? "GET" : "POST",
    path,
    query: new URLSearchParams(),
    accessOk: true,
    hasAccessHeaders: true,
    bearerOk: true,
    hasBearer: true,
    hasAuthorization: true,
    body: JSON.stringify(body),
    at: now,
    slack: null,
  };
}

const create = (body: Record<string, unknown>) =>
  helpdesk.override(request("/api/internal/test-tickets", body))!.json as Record<string, unknown>;

const viewOf = (mock: MockHelpdesk, testId: string) =>
  mock.override(request(`/api/internal/tickets/${mock.tickets.get(testId)!.ticketId}`))!
    .json as Record<string, unknown>;

/** Moves the fake clock to `ms` after T0 and lets every scheduled step land. */
function at(ms: number) {
  now = T0 + ms;
  helpdesk.tick();
}

describe("the mock phase 5 flow", () => {
  it("moves a ticket to one [E2E] incident, with the ticket number as display", () => {
    const created = create({ testId: "run:L01:1", email: "demo.carol@example.com", ...PRINTER });
    at(999);
    expect(viewOf(helpdesk, "run:L01:1")["status"]).toBe("new");
    at(1_000);
    expect(viewOf(helpdesk, "run:L01:1")["status"]).toBe("redacted");
    at(5_000);
    expect(viewOf(helpdesk, "run:L01:1")).toMatchObject({
      status: "auto",
      triage: { category: "hardware", route: "auto" },
      incident: null,
    });
    at(6_000);
    const pending = viewOf(helpdesk, "run:L01:1");
    expect(pending["status"]).toBe("helpdesk_pending");
    expect(pending["events"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "helpdesk_sync_started" })]),
    );
    at(7_000);
    expect(viewOf(helpdesk, "run:L01:1")).toMatchObject({
      status: "incident_created",
      aiCallCount: 1,
      incident: { number: "INC0000001" },
    });
    expect(data.incidents[0]).toMatchObject({
      category: "hardware",
      caller_id: data.users.find((u) => u["user_name"] === "demo.carol")!["sys_id"],
      correlation_id: created["ticketId"],
      correlation_display: created["ticketNumber"],
      short_description: "[E2E] Printer on level 2 is offline",
      state: "1",
    });
    expect(data.journal.filter((j) => j["element"] === "work_notes")).toHaveLength(1);
  });

  it("answers a repeated test ID with the same ticket and duplicate: true", () => {
    const body = { testId: "run:L03:1", email: "demo.carol@example.com", ...PRINTER };
    const first = create(body);
    const second = create(body);
    expect(second).toMatchObject({
      ticketId: first["ticketId"],
      ticketNumber: first["ticketNumber"],
      duplicate: true,
    });
    expect(helpdesk.tickets.size).toBe(1);
  });

  it("skips the incident in shadow mode", () => {
    create({
      testId: "run:L05:1",
      email: "demo.carol@example.com",
      ...PRINTER,
      testOverrides: { shadowMode: true },
    });
    at(7_000);
    const view = viewOf(helpdesk, "run:L05:1");
    expect(view["status"]).toBe("incident_skipped_shadow");
    expect(view["events"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "shadow_skipped" })]),
    );
    expect(data.incidents).toEqual([]);
  });

  it("answers nothing without the Access gate or the bearer token", () => {
    expect(helpdesk.override({ ...request("/api/internal/test-tickets"), accessOk: false })).toBe(
      undefined,
    );
    expect(helpdesk.override({ ...request("/api/internal/test-tickets"), bearerOk: false })).toBe(
      undefined,
    );
    expect(helpdesk.tickets.size).toBe(0);
  });
});
