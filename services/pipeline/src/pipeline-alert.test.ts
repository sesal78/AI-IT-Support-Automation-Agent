import { describe, expect, it, vi } from "vitest";
import { createPipelineAlert } from "./pipeline-alert.js";

const TICKET = "00000000-0000-4000-8000-000000000001";
// Built from pieces so no token-shaped literal sits in the source.
const token = ["xoxb", "test", "0000000000", "fake"].join("-");

function setup(env: Record<string, string | undefined>, count = 1) {
  const postMessage = vi.fn<(input: { channel: string; text: string }) => Promise<{ ts: string }>>(
    async () => ({ ts: "1.2" }),
  );
  const createClient = vi.fn(() => ({ postMessage }));
  const logger = { error: vi.fn() };
  const recordSecurityEvent = vi.fn(async () => count);
  const alert = createPipelineAlert(env, { recordSecurityEvent }, { createClient, logger });
  return { alert, postMessage, createClient, logger, recordSecurityEvent };
}

describe("createPipelineAlert", () => {
  it("posts nothing without the Slack env, but still records and logs", async () => {
    for (const env of [{}, { SLACK_BOT_TOKEN: token }, { SLACK_CHANNEL_ID: "C0000000001" }]) {
      const { alert, postMessage, createClient, logger, recordSecurityEvent } = setup(env);
      await alert("llm_unavailable", { ticketId: TICKET });
      expect(createClient).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
      expect(recordSecurityEvent).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(1);
    }
  });

  it("posts to SLACK_CHANNEL_ID when SLACK_ALERT_CHANNEL_ID is unset", async () => {
    const { alert, postMessage, createClient } = setup({
      SLACK_BOT_TOKEN: token,
      SLACK_CHANNEL_ID: "C0000000001",
      SLACK_ALERT_CHANNEL_ID: "",
    });
    await alert("llm_unavailable", { ticketId: TICKET });
    expect(createClient).toHaveBeenCalledWith({ token });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[0].channel).toBe("C0000000001");
    expect(postMessage.mock.calls[0]?.[0].text).toBe(
      `alert llm_unavailable ticket ${TICKET} (staging)`,
    );
  });

  it("posts to SLACK_ALERT_CHANNEL_ID when it is set, with the e2e environment", async () => {
    const { alert, postMessage } = setup({
      SLACK_BOT_TOKEN: token,
      SLACK_CHANNEL_ID: "C0000000001",
      SLACK_ALERT_CHANNEL_ID: "C0000000002",
      E2E_MODE: "true",
    });
    await alert("triage_failed", { ticketId: TICKET });
    expect(postMessage.mock.calls[0]?.[0]).toEqual({
      channel: "C0000000002",
      text: `alert triage_failed ticket ${TICKET} (e2e)`,
      blocks: [
        {
          type: "section",
          text: {
            type: "plain_text",
            text: `alert triage_failed ticket ${TICKET} (e2e)`,
            emoji: false,
          },
        },
      ],
    });
  });

  it("posts only for the first alert of the minute", async () => {
    const { alert, postMessage } = setup(
      { SLACK_BOT_TOKEN: token, SLACK_CHANNEL_ID: "C0000000001" },
      2,
    );
    await alert("llm_unavailable", { ticketId: TICKET });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("never throws when the post fails, and logs the class name only", async () => {
    const { alert, postMessage, logger } = setup({
      SLACK_BOT_TOKEN: token,
      SLACK_CHANNEL_ID: "C0000000001",
    });
    postMessage.mockRejectedValueOnce(
      Object.assign(new Error("secret-detail"), { name: "SlackApiError" }),
    );
    await expect(alert("llm_unavailable", { ticketId: TICKET })).resolves.toBeUndefined();
    const line = String(logger.error.mock.calls[0]?.[0]);
    expect(line).toContain("SlackApiError");
    expect(line).not.toContain("secret-detail");
  });

  it("throws, naming the variable, for a set but invalid Slack value", () => {
    expect(() => setup({ SLACK_BOT_TOKEN: token, SLACK_CHANNEL_ID: "#general" })).toThrow(
      /SLACK_CHANNEL_ID/,
    );
  });
});
