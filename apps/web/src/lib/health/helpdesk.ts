import { HELPDESK_HEALTH_TASK_ID, helpdeskHealthOutputSchema } from "@ai-it-support/shared";
import { runs } from "@trigger.dev/sdk";
import { CACHE_TTL_MS } from "./config";

/** The latest check counts for 45 minutes: 30 minutes between runs plus 15 of slack (resolved point 10). */
export const HELPDESK_HEALTH_MAX_AGE_MS = 45 * 60_000;

export interface HelpdeskHealth {
  reachable: boolean;
  asleep: boolean;
}

const NOTHING: HelpdeskHealth = { reachable: false, asleep: false };

interface RunLike {
  id: string;
  createdAt: Date;
  finishedAt?: Date | undefined;
  /** Not on list items in SDK 4.6.4: then `retrieve` supplies it. */
  output?: unknown;
}

/** The two `runs` functions this module needs, so a test can replace them. */
export interface HelpdeskRunsClient {
  list(params: {
    taskIdentifier: string;
    status: "COMPLETED";
    limit: number;
    period: string;
  }): PromiseLike<{ data: ReadonlyArray<RunLike> }>;
  retrieve(runId: string): PromiseLike<{ output?: unknown }>;
}

interface Options {
  client: HelpdeskRunsClient;
  now?: () => number;
  /** Receives one fixed-format line: the error class name, never a message. */
  log?: (message: string) => void;
}

// Error class name only: a message from the SDK can carry a URL or a key fragment.
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

interface Latest {
  status: "ok" | "asleep" | "down";
  /** Epoch ms the run finished (created, when it has no finish time). */
  at: number;
}

/**
 * Reads the output of the latest completed `helpdesk-health` run through the
 * Trigger.dev SDK (the web app has no ServiceNow credentials). `runs.list`
 * takes the newest completed run in a one hour window (the default window is
 * seven days; an older run is too old to count anyway), and `runs.retrieve`
 * supplies the output when the list item has none. The SDK answer, failures
 * included, is cached for 60 seconds, and callers during a miss share one
 * request. A clock that goes backwards counts as an expired entry.
 *
 * `reachable` is true when that run is at most 45 minutes old and said `ok`;
 * `asleep` when it is that fresh and said `asleep`. An older run says nothing
 * (the checker may have stopped), and so does a missing run, an SDK error or
 * an output that is not the expected shape: both false. `get` never rejects.
 */
export function createHelpdeskHealthReader({
  client,
  now = Date.now,
  log = (message) => console.error(message),
}: Options) {
  let cached: { at: number; result: Promise<Latest | null> } | undefined;

  async function readLatest(): Promise<Latest | null> {
    try {
      const page = await client.list({
        taskIdentifier: HELPDESK_HEALTH_TASK_ID,
        status: "COMPLETED",
        limit: 1,
        period: "1h",
      });
      const run = page.data[0];
      if (run === undefined) return null;
      const raw = run.output !== undefined ? run.output : (await client.retrieve(run.id)).output;
      const parsed = helpdeskHealthOutputSchema.safeParse(raw);
      if (!parsed.success) {
        log("[health-helpdesk] run output has an unexpected shape");
        return null;
      }
      return {
        status: parsed.data.status,
        at: new Date(run.finishedAt ?? run.createdAt).getTime(),
      };
    } catch (error) {
      log(`[health-helpdesk] read failed: ${errorName(error)}`);
      return null;
    }
  }

  async function get(): Promise<HelpdeskHealth> {
    const t = now();
    if (cached === undefined || t < cached.at || t - cached.at >= CACHE_TTL_MS) {
      cached = { at: t, result: readLatest() };
    }
    const latest = await cached.result;
    if (latest === null || !(t - latest.at <= HELPDESK_HEALTH_MAX_AGE_MS)) return NOTHING;
    return { reachable: latest.status === "ok", asleep: latest.status === "asleep" };
  }

  return { get };
}

let reader: ReturnType<typeof createHelpdeskHealthReader> | undefined;

/** `{ reachable, asleep }` for GET /api/health/config, from the real SDK. */
export function getHelpdeskHealth(): Promise<HelpdeskHealth> {
  reader ??= createHelpdeskHealthReader({
    client: {
      list: (params) => runs.list(params),
      retrieve: (runId) => runs.retrieve(runId),
    },
  });
  return reader.get();
}
