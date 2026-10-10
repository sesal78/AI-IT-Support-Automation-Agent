import { internalEnvShape, langfuseEnvShape, liveEnvShape, parseEnv } from "@ai-it-support/shared";

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
  /** Every secret-bearing value read from the environment, for leak checks. */
  readonly secrets: readonly string[];
}

const shape = {
  ...liveEnvShape,
  ...internalEnvShape,
  LANGFUSE_PUBLIC_KEY: langfuseEnvShape.LANGFUSE_PUBLIC_KEY.optional(),
  LANGFUSE_SECRET_KEY: langfuseEnvShape.LANGFUSE_SECRET_KEY.optional(),
  LANGFUSE_BASE_URL: langfuseEnvShape.LANGFUSE_BASE_URL.optional(),
};

const STAGING_MESSAGE = "E2E_BASE_URL: live tests never run against staging";

/**
 * Reads the live-suite variables from `env` by name. Throws a LiveConfigError
 * that names each bad variable and never quotes a value. E2E_BASE_URL must be
 * `https://…` or `http://127.0.0.1:<port>`, carry no credentials, query or
 * fragment, and must not be staging: its host must differ from the host of
 * STAGING_BASE_URL, and its first label must not contain "staging".
 */
export function loadLiveConfig(env: Record<string, string | undefined>): LiveConfig {
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

  let stagingOrigin: string | undefined;
  if (parsed.STAGING_BASE_URL !== undefined) {
    const staging = new URL(parsed.STAGING_BASE_URL);
    if (staging.hostname === base.hostname) throw new LiveConfigError(STAGING_MESSAGE);
    stagingOrigin = staging.origin;
  }
  const firstLabel = base.hostname.split(".")[0] ?? "";
  if (firstLabel.includes("staging")) throw new LiveConfigError(STAGING_MESSAGE);

  const secrets = [
    parsed.INTERNAL_API_TOKEN,
    parsed.CF_ACCESS_CLIENT_ID,
    parsed.CF_ACCESS_CLIENT_SECRET,
    parsed.LANGFUSE_PUBLIC_KEY,
    parsed.LANGFUSE_SECRET_KEY,
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
    secrets,
  };
}
