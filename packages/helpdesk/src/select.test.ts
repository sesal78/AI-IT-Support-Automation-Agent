import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BuiltinConnector, type BuiltinHelpdeskStore } from "./builtin.js";
import { HelpdeskError } from "./errors.js";
import { FakeConnector } from "./fake.js";
import { createHelpdeskConnector, selectHelpdeskConnector } from "./select.js";
import type { CreateHelpdeskTicketInput } from "./types.js";

function stubStore() {
  const store = {
    createHelpdeskTicket: vi.fn(),
    getHelpdeskTicketByTicketId: vi.fn().mockResolvedValue(null),
    getHelpdeskTicket: vi.fn(),
    addSystemNote: vi.fn(),
    setHelpdeskState: vi.fn(),
    setTicketHelpdesk: vi.fn(),
  };
  return { store: store as unknown as BuiltinHelpdeskStore, spies: store };
}

const input: CreateHelpdeskTicketInput = {
  ticketId: randomUUID(),
  ticketNumber: "ITS-000042",
  isTest: true,
  redactedTitle: "Printer offline",
  redactedDescription: "The printer on level 2 is offline.",
  category: "hardware",
  priority: "P3",
  assignmentGroup: null,
  requesterEmail: null,
};

describe("selectHelpdeskConnector", () => {
  it("builtin builds the built-in connector and never builds the ServiceNow one", () => {
    const { store } = stubStore();
    const serviceNow = vi.fn(() => new FakeConnector());
    const connector = selectHelpdeskConnector({ HELPDESK: "builtin" }, { store, serviceNow });
    expect(connector).toBeInstanceOf(BuiltinConnector);
    expect(connector.kind).toBe("builtin");
    expect(serviceNow).not.toHaveBeenCalled();
  });

  it("servicenow builds the ServiceNow connector and touches no built-in store", async () => {
    const { store, spies } = stubStore();
    const fake = new FakeConnector();
    const connector = selectHelpdeskConnector(
      { HELPDESK: "servicenow" },
      { store, serviceNow: () => fake },
    );
    expect(connector).toBe(fake);
    await connector.findByExternalRef(randomUUID());
    expect(Object.values(spies).flatMap((spy) => spy.mock.calls)).toEqual([]);
  });

  it("an unknown value fails closed with a config error that names no value", () => {
    const { store } = stubStore();
    const bad = { HELPDESK: "jira" } as never;
    const error = (() => {
      try {
        selectHelpdeskConnector(bad, { store, serviceNow: () => new FakeConnector() });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(HelpdeskError);
    expect((error as HelpdeskError).code).toBe("config");
    expect((error as Error).message).not.toContain("jira");
  });
});

describe("createHelpdeskConnector", () => {
  it("with shadow mode off, returns the chosen connector unchanged", () => {
    const { store } = stubStore();
    const connector = createHelpdeskConnector(
      { HELPDESK: "builtin" },
      { store, serviceNow: () => new FakeConnector(), shadow: { enabled: false } },
    );
    expect(connector).toBeInstanceOf(BuiltinConnector);
  });

  it("with shadow mode on, builtin writes are skipped: no row, no flag, reads pass through", async () => {
    const { store, spies } = stubStore();
    const log = vi.fn();
    const connector = createHelpdeskConnector(
      { HELPDESK: "builtin" },
      { store, serviceNow: () => new FakeConnector(), shadow: { enabled: true, log } },
    );
    expect(connector.kind).toBe("builtin");
    expect(await connector.createTicket(input)).toEqual({ skipped: "shadow" });
    expect(await connector.addNote({ externalId: randomUUID(), number: "HD0000001" }, "x")).toEqual(
      {
        skipped: "shadow",
      },
    );
    expect(await connector.findByExternalRef(input.ticketId)).toBeNull();
    expect(spies.createHelpdeskTicket).not.toHaveBeenCalled();
    expect(spies.setTicketHelpdesk).not.toHaveBeenCalled();
    expect(spies.addSystemNote).not.toHaveBeenCalled();
    expect(spies.getHelpdeskTicketByTicketId).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("shadow_skipped", { operation: "create" });
  });

  it("with shadow mode on, servicenow writes are skipped too", async () => {
    const { store } = stubStore();
    const fake = new FakeConnector();
    const connector = createHelpdeskConnector(
      { HELPDESK: "servicenow" },
      { store, serviceNow: () => fake, shadow: { enabled: true } },
    );
    expect(await connector.createTicket(input)).toEqual({ skipped: "shadow" });
    expect(fake.calls).toEqual([]);
  });

  it("decorate wraps the chosen connector before the shadow wrapper", async () => {
    const { store } = stubStore();
    const seen: string[] = [];
    const connector = createHelpdeskConnector(
      { HELPDESK: "builtin" },
      {
        store,
        serviceNow: () => new FakeConnector(),
        shadow: { enabled: true },
        decorate: (inner) => {
          seen.push(inner.kind);
          return inner;
        },
      },
    );
    expect(seen).toEqual(["builtin"]);
    expect(await connector.createTicket(input)).toEqual({ skipped: "shadow" });
  });
});
