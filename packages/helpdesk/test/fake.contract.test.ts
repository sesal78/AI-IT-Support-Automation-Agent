import { describe, expect, it } from "vitest";
import {
  FakeConnector,
  HelpdeskError,
  InstanceAsleepError,
  type CreateHelpdeskTicketInput,
  assertNoteBody,
  type HelpdeskTicketRef,
} from "../src/index.js";
import { helpdeskContractCases, runHelpdeskContract } from "../src/testing/contract.js";

const TICKET_ID = "5b0f3c1e-2d4a-4f6b-8c7d-9e0a1b2c3d4e";
const MARKER = "MARKER-TITLE-4e8b";
const input = (over: Partial<CreateHelpdeskTicketInput> = {}): CreateHelpdeskTicketInput => ({
  ticketId: TICKET_ID,
  ticketNumber: "ITS-000001",
  isTest: true,
  redactedTitle: "Printer offline",
  redactedDescription: "Offline.",
  category: "hardware",
  priority: "medium",
  assignmentGroup: null,
  requesterEmail: null,
  ...over,
});

runHelpdeskContract("fake", () => new FakeConnector());

class NeverFinds extends FakeConnector {
  override async findByExternalRef(ticketId: string): Promise<HelpdeskTicketRef | null> {
    await super.findByExternalRef(ticketId);
    return null;
  }
}
class IgnoresUnknownRef extends FakeConnector {
  override async addNote(ref: HelpdeskTicketRef, body: string): Promise<void> {
    assertNoteBody(body);
  }
}
class StoresExtraKeys extends FakeConnector {
  protected override recordedInput(raw: CreateHelpdeskTicketInput): unknown {
    return { ...raw };
  }
}

describe("the contract fails against broken fakes", () => {
  const failing = async (make: () => FakeConnector): Promise<string[]> => {
    const names: string[] = [];
    for (const testCase of helpdeskContractCases()) {
      await testCase.run(make(), []).catch(() => names.push(testCase.name));
    }
    return names;
  };
  it("a fake whose findByExternalRef always returns null", async () => {
    expect(await failing(() => new NeverFinds())).toEqual([
      "findByExternalRef returns the same ref",
    ]);
  });
  it("a fake whose addNote ignores unknown refs", async () => {
    expect(await failing(() => new IgnoresUnknownRef())).toEqual([
      "addNote on an unknown ref rejects with not_found",
    ]);
  });
  it("a fake that stores the extra marker keys", async () => {
    expect(await failing(() => new StoresExtraKeys())).toEqual([
      "extra input keys never reach anything recorded or sent",
    ]);
  });
});

describe("FakeConnector", () => {
  it("numbers tickets FAKE0000001 upwards", async () => {
    const fake = new FakeConnector();
    const a = await fake.createTicket(input());
    const b = await fake.createTicket(input({ ticketId: crypto.randomUUID() }));
    expect([a, b].map((r) => "number" in r && r.number)).toEqual(["FAKE0000001", "FAKE0000002"]);
  });
  it("failNext(unavailable) throws a retryable error once", async () => {
    const fake = new FakeConnector();
    fake.failNext("unavailable");
    const error = await fake.findByExternalRef(TICKET_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HelpdeskError);
    expect(error).toMatchObject({ code: "unavailable", retryable: true });
    expect(await fake.findByExternalRef(TICKET_ID)).toBeNull();
  });
  it("failNext(auth) is not retryable", async () => {
    const fake = new FakeConnector();
    fake.failNext("auth");
    expect(await fake.findByExternalRef(TICKET_ID).catch((e: unknown) => e)).toMatchObject({
      code: "auth",
      retryable: false,
    });
  });
  it("setAsleep(true) makes every call throw InstanceAsleepError and health asleep", async () => {
    const fake = new FakeConnector();
    fake.setAsleep(true);
    const ref = { externalId: "x", number: "y" };
    for (const call of [
      () => fake.createTicket(input()),
      () => fake.findByExternalRef(TICKET_ID),
      () => fake.addNote(ref, "n"),
      () => fake.updateTicket(ref, { state: "closed" }),
    ]) {
      expect(await call().catch((e: unknown) => e)).toBeInstanceOf(InstanceAsleepError);
    }
    expect(await fake.health()).toEqual({ status: "asleep" });
  });
  it("error messages and properties never hold a value", async () => {
    const fake = new FakeConnector();
    fake.failNext("unavailable");
    const failed = await fake
      .createTicket(input({ redactedTitle: MARKER }))
      .catch((e: unknown) => e);
    fake.setAsleep(true);
    const asleep = await fake
      .createTicket(input({ redactedTitle: MARKER }))
      .catch((e: unknown) => e);
    for (const error of [failed, asleep] as HelpdeskError[]) {
      expect(error.message).toBe(`helpdesk createTicket failed: ${error.code}`);
      expect(JSON.stringify({ ...error, message: error.message, stack: "" })).not.toContain(MARKER);
    }
  });
  it("throws TypeError with no recorded call for bad ticket IDs and notes", async () => {
    const fake = new FakeConnector();
    const ref = { externalId: "x", number: "y" };
    const bad = [
      fake.createTicket(input({ ticketId: "nope" })),
      fake.findByExternalRef("nope"),
      fake.addNote(ref, ""),
      fake.addNote(ref, "a".repeat(5001)),
      fake.updateTicket(ref, { state: "new" as "closed" }),
    ];
    for (const promise of bad)
      expect(await promise.catch((e: unknown) => e)).toBeInstanceOf(TypeError);
    expect(fake.calls).toEqual([]);
    await expect(fake.addNote({ externalId: "x", number: "y" }, "a".repeat(5000))).rejects.toThrow(
      HelpdeskError,
    );
    expect(fake.calls).toHaveLength(1);
  });
});
