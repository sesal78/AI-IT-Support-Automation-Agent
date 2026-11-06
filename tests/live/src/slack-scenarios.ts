// Phase 4 live scenarios that need only the guarded Slack helper.
import { missingSlackEnv } from "./config.ts";
import type { Scenario, ScenarioResult } from "./runner.ts";
import { createE2eSlackChannel, SlackChannelGuardError } from "./slack-channel.ts";

/** A channel ID that is never the e2e channel (the e2e ID is never a code default). */
export const PROBE_CHANNEL = "C0000000001";

/**
 * T4.S.06: once the guard has verified #itsupport-e2e, the helper refuses to
 * read, post or delete in any other channel (a fixed probe ID, and case and
 * space variants of the verified ID) before any request. Creates no ticket
 * and posts nothing.
 */
export const slackChannelGuardScenario: Scenario = {
  id: "T4.S.06",
  async run(ctx): Promise<ScenarioResult> {
    const missing = missingSlackEnv(ctx.config, ["E2E_SLACK_BOT_TOKEN", "E2E_SLACK_CHANNEL_ID"]);
    if (missing.length > 0) return { status: "not_run", evidence: { missing } };

    // Record the channel of every Slack request this scenario makes.
    const channels: string[] = [];
    const recording = (input: URL, init: RequestInit) => {
      const channel =
        typeof init.body === "string" ? new URLSearchParams(init.body).get("channel") : null;
      if (channel !== null) channels.push(channel);
      return ctx.fetch(input, init);
    };
    const slack = createE2eSlackChannel(ctx.config, recording);
    const { channelId } = await slack.verify();

    const probes = [
      channelId === PROBE_CHANNEL ? "C0000000002" : PROBE_CHANNEL,
      channelId.toLowerCase(),
      ` ${channelId}`,
      `${channelId} `,
    ];
    const attempts = probes.flatMap((probe) => [
      () => slack.history(probe, { oldest: "0" }),
      () => slack.replies(probe, "1700000000.000001"),
      () => slack.post(probe, "T4.S.06 probe"),
      () => slack.delete(probe, "1700000000.000001"),
    ]);
    let refused = 0;
    for (const attempt of attempts) {
      try {
        await attempt();
      } catch (error) {
        if (error instanceof SlackChannelGuardError) refused += 1;
      }
    }
    const probeRequests = channels.filter((channel) => probes.includes(channel)).length;
    return {
      status: refused === attempts.length && probeRequests === 0 ? "pass" : "fail",
      evidence: { attempts: attempts.length, refused, probeRequests, aiCallCount: 0 },
    };
  },
};

export const slackScenarios: readonly Scenario[] = [slackChannelGuardScenario];
