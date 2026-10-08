import { describe, expect, it, vi } from "vitest";
import { createAlertSink } from "./alert.js";

const TICKET = "00000000-0000-4000-8000-000000000001";

function setup(record: () => Promise<unknown> = async () => undefined) {
  const recordSecurityEvent = vi.fn(record);
  const logger = { error: vi.fn() };
  return { alert: createAlertSink({ recordSecurityEvent, logger }), recordSecurityEvent, logger };
}

describe("createAlertSink", () => {
  it("records a pipeline alert event with the ticket id and logs once", async () => {
    const { alert, recordSecurityEvent, logger } = setup();
    await alert("llm_unavailable", { ticketId: TICKET });
    expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
    expect(recordSecurityEvent).toHaveBeenCalledWith("pipeline", "alert:llm_unavailable", {
      ticketId: TICKET,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[0]).toContain("llm_unavailable");
  });

  it("records an empty sample when there is no ticket", async () => {
    const { alert, recordSecurityEvent } = setup();
    await alert("llm_cap_80");
    expect(recordSecurityEvent).toHaveBeenCalledWith("pipeline", "alert:llm_cap_80", {});
  });

  it("logs the error class name, not the message, and does not throw when recording fails", async () => {
    class DbError extends Error {
      override name = "DbError";
    }
    const secret = "secret".repeat(2);
    const { alert, logger } = setup(async () => {
      throw new DbError(`boom ${secret}`);
    });
    await expect(alert("typesafe_cap_80", { ticketId: TICKET })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = String(logger.error.mock.calls[0]?.[0]);
    expect(line).toContain("DbError");
    expect(line).not.toContain(secret);
  });

  it("does not throw when the recorder throws a non-Error or the logger throws", async () => {
    const recordSecurityEvent = vi.fn(async () => {
      throw "plain";
    });
    const logger = {
      error: vi.fn(() => {
        throw new Error("log down");
      }),
    };
    const alert = createAlertSink({ recordSecurityEvent, logger });
    await expect(alert("llm_cap_80")).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
