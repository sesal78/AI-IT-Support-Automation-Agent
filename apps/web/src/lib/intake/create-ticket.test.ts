import { beforeEach, describe, expect, it, vi } from "vitest";

const trigger = vi.hoisted(() => vi.fn());
vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger } }));

import { createAndEnqueueTicket } from "./create-ticket";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const input = {
  name: "Jo Tester",
  email: "jo@example.test",
  department: "Finance",
  title: "Laptop will not boot",
  description: "Black screen on boot, nothing else happens.",
  idempotencyKey: "web:" + "a".repeat(64),
};

const createTicket = vi.fn();
const addEvent = vi.fn();
const db = { createTicket, addEvent } as never;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  createTicket.mockReset().mockResolvedValue({ ticket: { id: TICKET_ID }, created: true });
  addEvent.mockReset().mockResolvedValue({});
  trigger.mockReset().mockResolvedValue({ id: "run_1" });
});

describe("createAndEnqueueTicket", () => {
  it("stores is_test and sends testOverrides for a test ticket", async () => {
    const result = await createAndEnqueueTicket(db, {
      ...input,
      isTest: true,
      testOverrides: { llmCallCap: 0 },
    });
    expect(result).toEqual({ outcome: "queued", ticketId: TICKET_ID });
    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ is_test: true }));
    expect(trigger).toHaveBeenCalledWith("intake-ticket", {
      ticketId: TICKET_ID,
      testOverrides: { llmCallCap: 0 },
    });
  });

  it("never sends testOverrides for a non-test ticket", async () => {
    await createAndEnqueueTicket(db, { ...input, isTest: false, testOverrides: { llmCallCap: 0 } });
    expect(trigger).toHaveBeenCalledWith("intake-ticket", { ticketId: TICKET_ID });
  });

  it("omits an empty testOverrides", async () => {
    await createAndEnqueueTicket(db, { ...input, isTest: true, testOverrides: {} });
    expect(trigger).toHaveBeenCalledWith("intake-ticket", { ticketId: TICKET_ID });
  });

  it("returns duplicate and does not trigger on a repeated idempotency key", async () => {
    createTicket.mockResolvedValue({ ticket: { id: TICKET_ID }, created: false });
    const result = await createAndEnqueueTicket(db, { ...input, isTest: false });
    expect(result).toEqual({ outcome: "duplicate", ticketId: TICKET_ID });
    expect(trigger).not.toHaveBeenCalled();
    expect(addEvent).not.toHaveBeenCalled();
  });

  it("records enqueue_failed when the trigger fails", async () => {
    trigger.mockRejectedValue(new Error("down"));
    const result = await createAndEnqueueTicket(db, { ...input, isTest: false });
    expect(result).toEqual({ outcome: "enqueue_failed", ticketId: TICKET_ID });
    expect(addEvent).toHaveBeenCalledWith(TICKET_ID, "enqueue_failed", { error: "Error" });
  });

  it("returns store_failed without triggering when storing fails", async () => {
    createTicket.mockRejectedValue(new Error("db"));
    const result = await createAndEnqueueTicket(db, { ...input, isTest: false });
    expect(result).toEqual({ outcome: "store_failed" });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("rejects an invalid switch before triggering", async () => {
    await expect(
      createAndEnqueueTicket(db, { ...input, isTest: true, testOverrides: { llmCallCap: -1 } }),
    ).rejects.toThrow();
    expect(trigger).not.toHaveBeenCalled();
  });
});
