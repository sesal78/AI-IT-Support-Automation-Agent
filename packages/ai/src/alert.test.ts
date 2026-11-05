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

describe("createAlertSink with postAlert (P4-T10)", () => {
  function withPost(record: () => Promise<unknown>, post: (line: string) => Promise<unknown>) {
    const recordSecurityEvent = vi.fn(record);
    const postAlert = vi.fn(post);
    const logger = { error: vi.fn() };
    const alert = createAlertSink({ recordSecurityEvent, logger, postAlert, environment: "e2e" });
    return { alert, postAlert, logger };
  }

  it("posts the line once when the recorder returns 1", async () => {
    const { alert, postAlert } = withPost(
      async () => 1,
      async () => undefined,
    );
    await alert("llm_unavailable", { ticketId: TICKET });
    expect(postAlert).toHaveBeenCalledTimes(1);
    expect(postAlert).toHaveBeenCalledWith(`alert llm_unavailable ticket ${TICKET} (e2e)`);
  });

  it("does not post when the recorder returns 2", async () => {
    const { alert, postAlert, logger } = withPost(
      async () => 2,
      async () => undefined,
    );
    await alert("llm_unavailable", { ticketId: TICKET });
    expect(postAlert).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("posts without a ticket part when no ticket is given", async () => {
    const { alert, postAlert } = withPost(
      async () => 1,
      async () => undefined,
    );
    await alert("llm_cap_80");
    expect(postAlert).toHaveBeenCalledWith("alert llm_cap_80 (e2e)");
  });

  it("still posts once when recording throws, and logs the error class name", async () => {
    class DbError extends Error {
      override name = "DbError";
    }
    const { alert, postAlert, logger } = withPost(
      async () => {
        throw new DbError("db down");
      },
      async () => undefined,
    );
    await alert("triage_failed", { ticketId: TICKET });
    expect(postAlert).toHaveBeenCalledTimes(1);
    expect(postAlert).toHaveBeenCalledWith(`alert triage_failed ticket ${TICKET} (e2e)`);
    const line = String(logger.error.mock.calls[0]?.[0]);
    expect(line).toContain("DbError");
    expect(line).not.toContain("db down");
  });

  it("resolves when postAlert throws, and logs the class name only", async () => {
    class SlackApiError extends Error {
      override name = "SlackApiError";
    }
    const marker = `marker-${"z".repeat(8)}`;
    const { alert, logger } = withPost(
      async () => 1,
      async () => {
        throw new SlackApiError(`failed ${marker}`);
      },
    );
    await expect(alert("llm_unavailable", { ticketId: TICKET })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const line = String(logger.error.mock.calls[0]?.[0]);
    expect(line).toContain("SlackApiError");
    expect(line).not.toContain(marker);
  });

  it("posts only the kind, the ticket id and the environment", async () => {
    const marker = "MARKER-RAW-TEXT";
    const { alert, postAlert } = withPost(
      async () => 1,
      async () => undefined,
    );
    const options = { ticketId: TICKET, title: marker, email: marker } as { ticketId: string };
    await alert("llm_unavailable", options);
    expect(JSON.stringify(postAlert.mock.calls)).not.toContain(marker);
  });
});
