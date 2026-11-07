import { effectiveTestOverrides } from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";
import {
  FakeConnector,
  shadowEnabled,
  withShadowMode,
  type CreateHelpdeskTicketInput,
  type CreatedHelpdeskTicket,
  type HelpdeskTicketRef,
  type ShadowOperation,
} from "./index.js";

const TICKET_ID = "5b0f3c1e-2d4a-4f6b-8c7d-9e0a1b2c3d4e";
const MARKER_TITLE = "MARKER-TITLE-7c1d";
const MARKER_DESC = "MARKER-DESC-93ab";
const MARKER_NOTE = "MARKER-NOTE-5e2f";
const input: CreateHelpdeskTicketInput = {
  ticketId: TICKET_ID,
  isTest: true,
  redactedTitle: MARKER_TITLE,
  redactedDescription: MARKER_DESC,
  category: "hardware",
  priority: "medium",
  assignmentGroup: null,
  requesterEmail: null,
};
const ref: HelpdeskTicketRef = { externalId: "sys-1", number: "INC0010001" };

describe("withShadowMode", () => {
  // T5.I.04 with the FakeConnector. TODO(P5-T3b): re-run this case against
  // `new ServiceNowConnector(...)` under msw and assert the recorder sees no
  // POST or PATCH request (a findByExternalRef GET is allowed).
  it("T5.I.04: skips every write, never calls the inner connector for it, passes reads through", async () => {
    const inner = new FakeConnector();
    const created = (await inner.createTicket(input)) as CreatedHelpdeskTicket;
    inner.calls.length = 0;
    const wrapped = withShadowMode(inner, { enabled: true });

    expect(await wrapped.createTicket(input)).toEqual({ skipped: "shadow" });
    expect(await wrapped.addNote(created, "a note")).toEqual({ skipped: "shadow" });
    expect(await wrapped.updateTicket(created, { state: "resolved" })).toEqual({
      skipped: "shadow",
    });
    expect(inner.calls).toEqual([]);

    expect(await wrapped.findByExternalRef(TICKET_ID)).toEqual({
      externalId: created.externalId,
      number: created.number,
    });
    expect((await wrapped.health()).status).toBe("ok");
    expect(inner.calls.map((call) => call.operation)).toEqual(["findByExternalRef", "health"]);
    expect(wrapped.kind).toBe("fake");
  });

  it("returns the same object when disabled, and every call reaches it", async () => {
    const inner = new FakeConnector();
    const wrapped = withShadowMode(inner, { enabled: false });
    expect(wrapped).toBe(inner);
    const created = await wrapped.createTicket(input);
    expect(created).toMatchObject({ number: "FAKE0000001" });
    await wrapped.addNote(created as HelpdeskTicketRef, "a note");
    await wrapped.updateTicket(created as HelpdeskTicketRef, { state: "closed" });
    expect(inner.calls.map((call) => call.operation)).toEqual([
      "createTicket",
      "addNote",
      "updateTicket",
    ]);
  });

  it("passes a read failure through to the caller", async () => {
    const inner = new FakeConnector();
    const wrapped = withShadowMode(inner, { enabled: true });
    inner.failNext("unavailable");
    await expect(wrapped.findByExternalRef(TICKET_ID)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("logs shadow_skipped once per write with the operation only, no ticket text", async () => {
    const lines: unknown[][] = [];
    const wrapped = withShadowMode(new FakeConnector(), {
      enabled: true,
      log: (...args) => lines.push(args),
    });
    await wrapped.createTicket(input);
    await wrapped.addNote(ref, MARKER_NOTE);
    await wrapped.updateTicket(ref, { state: "on_hold" });
    await wrapped.findByExternalRef(TICKET_ID);
    await wrapped.health();

    const operations: ShadowOperation[] = ["create", "note", "update"];
    expect(lines).toEqual(operations.map((operation) => ["shadow_skipped", { operation }]));
    const text = JSON.stringify(lines);
    for (const marker of [MARKER_TITLE, MARKER_DESC, MARKER_NOTE, TICKET_ID, ref.number]) {
      expect(text).not.toContain(marker);
    }
  });

  it("works without a log function", async () => {
    const wrapped = withShadowMode(new FakeConnector(), { enabled: true });
    expect(await wrapped.addNote(ref, "x")).toEqual({ skipped: "shadow" });
  });
});

describe("shadowEnabled", () => {
  const cases: {
    name: string;
    shadowEnv: boolean;
    e2eMode: boolean;
    isTest: boolean;
    requested?: unknown;
    expected: boolean;
  }[] = [
    { name: "env on, no overrides", shadowEnv: true, e2eMode: true, isTest: true, expected: true },
    {
      name: "env on, whatever the overrides",
      shadowEnv: true,
      e2eMode: false,
      isTest: false,
      requested: { shadowMode: true },
      expected: true,
    },
    {
      name: "env off, e2e test ticket asks for shadow",
      shadowEnv: false,
      e2eMode: true,
      isTest: true,
      requested: { shadowMode: true },
      expected: true,
    },
    {
      name: "env off, empty overrides",
      shadowEnv: false,
      e2eMode: true,
      isTest: true,
      requested: {},
      expected: false,
    },
    {
      name: "env off, no overrides",
      shadowEnv: false,
      e2eMode: true,
      isTest: true,
      expected: false,
    },
    {
      name: "staging (E2E_MODE=false) ignores a requested shadowMode",
      shadowEnv: false,
      e2eMode: false,
      isTest: true,
      requested: { shadowMode: true },
      expected: false,
    },
    {
      name: "e2e mode but not a test ticket ignores a requested shadowMode",
      shadowEnv: false,
      e2eMode: true,
      isTest: false,
      requested: { shadowMode: true },
      expected: false,
    },
  ];

  it.each(cases)("$name", ({ shadowEnv, e2eMode, isTest, requested, expected }) => {
    const overrides = effectiveTestOverrides({ e2eMode, isTest, requested });
    expect(shadowEnabled({ env: { SHADOW_MODE: shadowEnv }, overrides })).toBe(expected);
  });
});
