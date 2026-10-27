import {
  internalEnvShape,
  langfuseEnvShape,
  liveEnvShape,
  liveSlackEnvShape,
  parseEnv,
} from "@ai-it-support/shared";

/** Thrown for a missing or refused variable. The message names variables, never values. */
export class LiveConfigError extends Error {
  override readonly name = "LiveConfigError";
}

export interface LiveConfig {
  /** Origin of E2E_BASE_URL (scheme, host and port; no path). */
  readonly origin: string;
  /** Host (and port) of E2E_BASE_URL, the only part of it a report shows. */
  readonly host: string;
  readonly internalApiToken: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  /** Origin of STAGING_BASE_URL, when set. */
  readonly stagingOrigin: string | undefined;
  readonly langfuse: {
    readonly publicKey: string | undefined;
    readonly secretKey: string | undefined;
    readonly baseUrl: string | undefined;
  };
  /** The e2e Slack variables; each is undefined when unset (scenarios then report not_run). */
  readonly slack: {
    readonly botToken: string | undefined;
    readonly channelId: string | undefined;
    readonly signingSecret: string | undefined;
    readonly reviewerId: string | undefined;
  };
  /** Every secret-bearing value read from the environment, for leak checks. */
  readonly secrets: readonly string[];
}

const shape = {
  ...liveEnvShape,
  ...internalEnvShape,
  LANGFUSE_PUBLIC_KEY: langfuseEnvShape.LANGFUSE_PUBLIC_KEY.optional(),
  LANGFUSE_SECRET_KEY: langfuseEnvShape.LANGFUSE_SECRET_KEY.optional(),
  LANGFUSE_BASE_URL: langfuseEnvShape.LANGFUSE_BASE_URL.optional(),
  ...liveSlackEnvShape,
};

// Lower-case, without one trailing dot: `qa.example.com.` is the same host as `qa.example.com`.
const normalHost = (hostname: string): string => hostname.toLowerCase().replace(/\.$/, "");

const STAGING_MESSAGE = "E2E_BASE_URL: live tests never run against staging";

/**
 * True when `hostname` is staging: the host of `stagingOrigin` (any case, one
 * trailing dot ignored), or a host whose first label contains "staging".
 */
export function isStagingHost(hostname: string, stagingOrigin: string | undefined): boolean {
  const host = normalHost(hostname);
  if (stagingOrigin !== undefined && normalHost(new URL(stagingOrigin).hostname) === host) {
    return true;
  }
  return (host.split(".")[0] ?? "").includes("staging");
}

/**
 * Reads the live-suite variables from `env` by name. Throws a LiveConfigError
 * that names each bad variable and never quotes a value. E2E_BASE_URL must be
 * `https://…` or `http://127.0.0.1:<port>`, carry no credentials, query or
 * fragment, and must not be staging: its host must differ from the host of
 * STAGING_BASE_URL, and its first label must not contain "staging".
 */
export function loadLiveConfig(env: Record<string, string | undefined>): LiveConfig {
  // The real (staging) signing secret must never be in a test process (plan
  // §2.1). Set at all, even empty, is refused: the name alone means a loader
  // mapped it here.
  if (env["SLACK_SIGNING_SECRET"] !== undefined) {
    throw new LiveConfigError("SLACK_SIGNING_SECRET: must not be set in the live-test process");
  }
  let parsed;
  try {
    parsed = parseEnv(shape, env);
  } catch (error) {
    // parseEnv names variables only; rethrow without the original as cause.
    throw new LiveConfigError(error instanceof Error ? error.message : "Invalid environment");
  }

  const base = new URL(parsed.E2E_BASE_URL);
  const loopback = base.protocol === "http:" && base.hostname === "127.0.0.1" && base.port !== "";
  if (
    !(base.protocol === "https:" || loopback) ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new LiveConfigError(
      "E2E_BASE_URL: must be https://<host> or http://127.0.0.1:<port>, without credentials, query or fragment",
    );
  }

  const stagingOrigin =
    parsed.STAGING_BASE_URL === undefined ? undefined : new URL(parsed.STAGING_BASE_URL).origin;
  if (isStagingHost(base.hostname, stagingOrigin)) throw new LiveConfigError(STAGING_MESSAGE);

  const secrets = [
    parsed.INTERNAL_API_TOKEN,
    parsed.CF_ACCESS_CLIENT_ID,
    parsed.CF_ACCESS_CLIENT_SECRET,
    parsed.LANGFUSE_PUBLIC_KEY,
    parsed.LANGFUSE_SECRET_KEY,
    parsed.E2E_SLACK_BOT_TOKEN,
    parsed.E2E_SLACK_SIGNING_SECRET,
  ].filter((value): value is string => value !== undefined);

  return {
    origin: base.origin,
    host: base.host,
    internalApiToken: parsed.INTERNAL_API_TOKEN,
    accessClientId: parsed.CF_ACCESS_CLIENT_ID,
    accessClientSecret: parsed.CF_ACCESS_CLIENT_SECRET,
    stagingOrigin,
    langfuse: {
      publicKey: parsed.LANGFUSE_PUBLIC_KEY,
      secretKey: parsed.LANGFUSE_SECRET_KEY,
      baseUrl: parsed.LANGFUSE_BASE_URL,
    },
    slack: {
      botToken: parsed.E2E_SLACK_BOT_TOKEN,
      channelId: parsed.E2E_SLACK_CHANNEL_ID,
      signingSecret: parsed.E2E_SLACK_SIGNING_SECRET,
      reviewerId: parsed.E2E_SLACK_REVIEWER_ID,
    },
    secrets,
  };
}

const SLACK_FIELDS = {
  E2E_SLACK_BOT_TOKEN: "botToken",
  E2E_SLACK_CHANNEL_ID: "channelId",
  E2E_SLACK_SIGNING_SECRET: "signingSecret",
  E2E_SLACK_REVIEWER_ID: "reviewerId",
} as const;

export type SlackEnvName = keyof typeof SLACK_FIELDS;

/** The names in `names` whose variable is unset, in the given order. */
export function missingSlackEnv(config: LiveConfig, names: readonly SlackEnvName[]): string[] {
  return names.filter((name) => config.slack[SLACK_FIELDS[name]] === undefined);
}
