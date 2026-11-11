import type { HealthConfig } from "@ai-it-support/shared";
import type { HelpdeskHealth } from "./helpdesk";

export const CACHE_TTL_MS = 60_000;

export interface SchemaProbeResult {
  database: boolean;
  migration0003: boolean;
  migration0005: boolean;
}

/** Env-derived values. Booleans and the version only: never the env values themselves. */
export interface EnvFlags {
  version: string;
  pipelineTrigger: boolean;
  turnstile: boolean;
  internalApi: boolean;
  e2eMode: boolean;
  slackInteractivity: boolean;
}

interface Options {
  probe: () => Promise<SchemaProbeResult>;
  /** Cached by the reader itself, so it is asked on every request. */
  helpdesk: () => Promise<HelpdeskHealth>;
  flags: EnvFlags;
  now?: () => number;
}

const DOWN: SchemaProbeResult = { database: false, migration0003: false, migration0005: false };
// Error class name only: messages and stacks can carry connection details.
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/**
 * Builds the body of GET /api/health/config. The database probe is cached for
 * 60 seconds, failures included, so a public caller cannot hammer a database
 * that is down. Concurrent callers during a miss share one in-flight probe. A
 * clock that goes backwards counts as an expired entry.
 */
export function createHealthConfigProvider({ probe, helpdesk, flags, now = Date.now }: Options) {
  let cached: { at: number; result: Promise<SchemaProbeResult> } | undefined;

  async function runProbe(): Promise<SchemaProbeResult> {
    try {
      const result = await probe();
      return {
        database: result.database === true,
        migration0003: result.migration0003 === true,
        migration0005: result.migration0005 === true,
      };
    } catch (error) {
      console.error(`[health-config] probe failed: ${errorName(error)}`);
      return DOWN;
    }
  }

  async function readHelpdesk(): Promise<HelpdeskHealth> {
    try {
      const read = await helpdesk();
      return { reachable: read.reachable === true, asleep: read.asleep === true };
    } catch (error) {
      console.error(`[health-config] helpdesk read failed: ${errorName(error)}`);
      return { reachable: false, asleep: false };
    }
  }

  async function get(): Promise<HealthConfig> {
    const t = now();
    if (cached === undefined || t < cached.at || t - cached.at >= CACHE_TTL_MS) {
      cached = { at: t, result: runProbe() };
    }
    const [probed, desk] = await Promise.all([cached.result, readHelpdesk()]);
    const { version, ...envFlags } = flags;
    return {
      version,
      features: {
        ...probed,
        ...envFlags,
        helpdeskReachable: desk.reachable,
        helpdeskAsleep: desk.asleep,
      },
    };
  }

  return { get };
}
