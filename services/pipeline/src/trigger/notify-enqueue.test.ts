import type { AlertFn } from "@ai-it-support/ai";
import { NOTIFY_REQUESTER_TASK_ID, notifyRequesterPayloadSchema } from "@ai-it-support/shared";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueNotify,
  notifyRequesterIdempotencyKey,
  type NotifyEnqueueDeps,
  type TriggerNotifyFn,
} from "./notify-enqueue.js";

const TICKET = "00000000-0000-4000-8000-000000000001";
const MARKER = "marker.requester@example.test";

function harness(
  options: { triggerError?: unknown; events?: string[]; addEventError?: unknown } = {},
) {
  const events = [...(options.events ?? [])];
  const written: Array<{ type: string; payload: unknown }> = [];
  const deps = {
    task: "helpdesk-sync",
    repos: {
      listEventTypes: vi.fn(async (_id: string, types: readonly string[]) =>
        events.filter((type) => types.includes(type)),
      ),
      addEvent: vi.fn(async (_id: string, type: string, payload?: Record<string, unknown>) => {
        if (options.addEventError) throw options.addEventError;
        events.push(type);
        written.push({ type, payload });
        return {} as never;
      }),
    },
    triggerNotify: vi.fn<TriggerNotifyFn>(async () => {
      if (options.triggerError) throw options.triggerError;
    }),
    alert: vi.fn<AlertFn>(async () => undefined),
    logger: { error: vi.fn() },
  } satisfies NotifyEnqueueDeps;
  return { deps, written };
}

describe("notifyRequesterIdempotencyKey", () => {
  it("is the task id, the ticket and the kind, so each email kind has its own run", () => {
    expect(notifyRequesterIdempotencyKey(TICKET, "incident_reply")).toBe(
      `${NOTIFY_REQUESTER_TASK_ID}:${TICKET}:incident_reply`,
    );
    expect(notifyRequesterIdempotencyKey(TICKET, "needs_info")).not.toBe(
      notifyRequesterIdempotencyKey(TICKET, "incident_reply"),
    );
  });
});

describe("enqueueNotify", () => {
  it.each(["incident_reply", "needs_info"] as const)(
    "triggers the task once with the ticket and the kind %s and nothing else",
    async (kind) => {
      const h = harness();
      await enqueueNotify({ ticketId: TICKET, kind }, h.deps);
      expect(h.deps.triggerNotify).toHaveBeenCalledTimes(1);
      const [payload, options] = vi.mocked(h.deps.triggerNotify).mock.calls[0]!;
      expect(payload).toEqual({ ticketId: TICKET, kind });
      expect(notifyRequesterPayloadSchema.safeParse(payload).success).toBe(true);
      expect(options).toEqual({ idempotencyKey: notifyRequesterIdempotencyKey(TICKET, kind) });
      expect(h.deps.alert).not.toHaveBeenCalled();
      expect(h.written).toEqual([]);
    },
  );

  it("a failed trigger records notify_enqueue_failed and one alert, and does not throw", async () => {
    const h = harness({ triggerError: new TypeError(`boom ${MARKER}`) });
    await expect(
      enqueueNotify({ ticketId: TICKET, kind: "incident_reply" }, h.deps),
    ).resolves.toBeUndefined();
    expect(h.written).toEqual([
      { type: "notify_enqueue_failed", payload: { kind: "incident_reply", error: "TypeError" } },
    ]);
    expect(h.deps.alert).toHaveBeenCalledExactlyOnceWith("notify_enqueue_failed", {
      ticketId: TICKET,
    });
    expect(JSON.stringify([h.written, h.deps.logger.error.mock.calls])).not.toContain(MARKER);
  });

  it("writes the event once for a ticket however often the trigger fails", async () => {
    const h = harness({ triggerError: new Error("down") });
    await enqueueNotify({ ticketId: TICKET, kind: "incident_reply" }, h.deps);
    await enqueueNotify({ ticketId: TICKET, kind: "incident_reply" }, h.deps);
    expect(h.written).toHaveLength(1);
  });

  it("does not throw when the failure cannot be recorded either, and logs the class name only", async () => {
    const h = harness({
      triggerError: new Error("down"),
      addEventError: new Error(`db down ${MARKER}`),
    });
    await expect(
      enqueueNotify({ ticketId: TICKET, kind: "needs_info" }, h.deps),
    ).resolves.toBeUndefined();
    expect(h.deps.logger.error).toHaveBeenCalled();
    expect(JSON.stringify(h.deps.logger.error.mock.calls)).not.toContain(MARKER);
  });

  it("has no way to change the ticket status", () => {
    const h = harness();
    expect(Object.keys(h.deps.repos).sort()).toEqual(["addEvent", "listEventTypes"]);
  });
});
