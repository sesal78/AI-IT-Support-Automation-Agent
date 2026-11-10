import {
  FakeConnector,
  InstanceAsleepError,
  type CreateHelpdeskTicketInput,
} from "@ai-it-support/helpdesk";
import { describe, expect, it } from "vitest";
import { asleepUntil, withAsleepSwitch } from "./asleep-switch.js";

const CREATED_AT = "2026-11-10T10:00:00.000+00:00";
const MINUTE = 60_000;
const created = Date.parse(CREATED_AT);

const input: CreateHelpdeskTicketInput = {
  ticketId: "7b1f6a5e-3c41-4a2b-9d0e-5f8a1c2d3e4f",
  ticketNumber: "ITS-000042",
  isTest: true,
  redactedTitle: "Printer jam",
  redactedDescription: "The printer on level 2 is jammed",
  category: "hardware",
  priority: "P3",
  assignmentGroup: "Hardware Support",
  requesterEmail: null,
};
const ref = { externalId: "a".repeat(32), number: "INC0010001" };

function setup(nowMs: number) {
  const inner = new FakeConnector();
  let clock = nowMs;
  const wrapped = withAsleepSwitch(inner, {
    asleepUntil: asleepUntil(CREATED_AT, 3),
    now: () => clock,
  });
  return { inner, wrapped, setNow: (value: number) => void (clock = value) };
}

describe("asleepUntil", () => {
  it("is created_at plus the minutes, in epoch milliseconds", () => {
    expect(asleepUntil(CREATED_AT, 3)).toBe(created + 3 * MINUTE);
    expect(asleepUntil(CREATED_AT, 30)).toBe(created + 30 * MINUTE);
  });

  it("throws for a created_at that is not a date", () => {
    expect(() => asleepUntil("not a date", 3)).toThrow(TypeError);
  });
});

describe("withAsleepSwitch", () => {
  it("keeps the kind of the connector it wraps", () => {
    expect(setup(created).wrapped.kind).toBe("fake");
  });

  it.each([
    ["createTicket", (c: ReturnType<typeof setup>["wrapped"]) => c.createTicket(input)],
    [
      "findByExternalRef",
      (c: ReturnType<typeof setup>["wrapped"]) => c.findByExternalRef(input.ticketId),
    ],
    ["addNote", (c: ReturnType<typeof setup>["wrapped"]) => c.addNote(ref, "note")],
    [
      "updateTicket",
      (c: ReturnType<typeof setup>["wrapped"]) => c.updateTicket(ref, { state: "closed" }),
    ],
  ])(
    "%s throws InstanceAsleepError before the time, without calling the connector",
    async (operation, call) => {
      const { inner, wrapped } = setup(created + 3 * MINUTE - 1);
      const error = await call(wrapped).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(InstanceAsleepError);
      expect((error as InstanceAsleepError).operation).toBe(operation);
      expect((error as InstanceAsleepError).retryable).toBe(true);
      expect(inner.calls).toEqual([]);
    },
  );

  it("answers health asleep before the time and passes it through after", async () => {
    const { inner, wrapped, setNow } = setup(created);
    expect(await wrapped.health()).toEqual({ status: "asleep" });
    expect(inner.calls).toEqual([]);
    setNow(created + 3 * MINUTE);
    expect(await wrapped.health()).toEqual({ status: "ok" });
  });

  it("lets real calls through from the exact time on", async () => {
    const { inner, wrapped } = setup(created + 3 * MINUTE);
    const result = await wrapped.createTicket(input);
    expect(result).toMatchObject({ number: expect.any(String) });
    expect(await wrapped.findByExternalRef(input.ticketId)).not.toBeNull();
    expect(inner.calls.map((call) => call.operation)).toEqual([
      "createTicket",
      "findByExternalRef",
    ]);
  });

  it("stays asleep one millisecond before the time and wakes up when the clock moves on", async () => {
    const { wrapped, setNow } = setup(created + 3 * MINUTE - 1);
    await expect(wrapped.findByExternalRef(input.ticketId)).rejects.toBeInstanceOf(
      InstanceAsleepError,
    );
    setNow(created + 3 * MINUTE);
    await expect(wrapped.findByExternalRef(input.ticketId)).resolves.toBeNull();
  });
});
