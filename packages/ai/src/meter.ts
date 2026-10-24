import type { AlertFn, AlertKind } from "./alert.js";

export type MeterProvider = "llm" | "typesafe";

export interface MeterReservationInput {
  provider: MeterProvider;
  kind: string;
  calls: number;
  capCalls: number;
  environment: string;
  ticketId?: string | undefined;
}

export interface MeterReservation {
  allowed: boolean;
  usedCalls: number;
  callId: string | null;
}

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

/** The two repository functions the meter needs (packages/db), passed in. */
export interface MeterRepos {
  reserveAiCall(input: MeterReservationInput): Promise<MeterReservation>;
  completeAiCall(callId: string, usage: TokenUsage): Promise<unknown>;
}

export interface MeterLogger {
  error(message: string): void;
}

export interface MeterCaps {
  llm: number;
  typesafe: number;
}

export interface MeterDeps {
  repos: MeterRepos;
  caps: MeterCaps;
  environment: string;
  alert: AlertFn;
  /** Defaults to console.error. Receives error class names only. */
  logger?: MeterLogger;
}

export interface MeterRunOptions {
  provider: MeterProvider;
  kind: string;
  ticketId?: string | undefined;
  /** Calls to reserve; a whole number from 1. Default 1. */
  calls?: number;
  /** Replaces the env cap for this call. 0 refuses the call. */
  capOverride?: number;
}

/** Thrown when the monthly cap would be exceeded. Carries the provider name only. */
export class BudgetExceededError extends Error {
  readonly provider: MeterProvider;

  constructor(provider: MeterProvider) {
    super(`AI budget exceeded for provider ${provider}`);
    this.name = "BudgetExceededError";
    this.provider = provider;
  }
}

// Same bound as the database column (integer) and the RPC arguments.
const INT32_MAX = 2_147_483_647;
const PROVIDERS: readonly string[] = ["llm", "typesafe"];

function isCount(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= INT32_MAX;
}

/** ceil(0.8 * cap) in integer arithmetic, so there is no float rounding. */
export function alertThreshold(cap: number): number {
  return Math.floor((cap * 4 + 4) / 5);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Metered AI calls (spend control, fail closed). `run` reserves the budget
 * first and only then calls `fn`; a refused or failed reservation never runs
 * `fn`. A reservation counts toward the cap even when `fn` fails or the
 * completion write fails.
 *
 * Decisions:
 * - 80 % means `used >= ceil(0.8 * cap)` after the reservation. The alert fires
 *   once, on the crossing (`used - calls < threshold <= used`), not on every
 *   call above it.
 * - An alert never blocks or fails the AI call: it is not awaited and any
 *   error, sync or async, is swallowed.
 * - If `fn` resolves but `completeAiCall` fails, the result is still returned
 *   and the error class name is logged: the reserved row exists and counts,
 *   and the AI work was already paid for.
 * - `fn` errors are rethrown untouched and never logged by the meter.
 * - `fn` resolves to a value carrying `tokensIn` and `tokensOut`; the whole
 *   value is returned. Counts that are not whole numbers from 0 skip the
 *   completion write (the row keeps null tokens).
 */
export function createMeter(deps: MeterDeps) {
  const { repos, caps, environment, alert } = deps;
  const logger = deps.logger ?? console;
  if (!isCount(caps.llm, 0) || !isCount(caps.typesafe, 0)) {
    throw new TypeError("caps must be whole numbers from 0");
  }

  return {
    async run<T extends TokenUsage>(options: MeterRunOptions, fn: () => Promise<T>): Promise<T> {
      const { provider, kind, ticketId, calls = 1, capOverride } = options;
      if (!PROVIDERS.includes(provider)) throw new TypeError("provider must be llm or typesafe");
      if (!isCount(calls, 1)) throw new TypeError("calls must be a whole number from 1");
      if (capOverride !== undefined && !isCount(capOverride, 0)) {
        throw new TypeError("capOverride must be a whole number from 0");
      }
      const capCalls = capOverride ?? caps[provider];

      const reservation = await repos.reserveAiCall({
        provider,
        kind,
        calls,
        capCalls,
        environment,
        ticketId,
      });
      if (!reservation.allowed || reservation.callId === null) {
        throw new BudgetExceededError(provider);
      }
      const { callId, usedCalls } = reservation;

      const threshold = alertThreshold(capCalls);
      if (usedCalls - calls < threshold && threshold <= usedCalls) {
        raise(alert, `${provider}_cap_80`, ticketId);
      }

      const result = await fn();

      if (isCount(result.tokensIn, 0) && isCount(result.tokensOut, 0)) {
        try {
          await repos.completeAiCall(callId, {
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
          });
        } catch (error) {
          safeLog(logger, `completeAiCall failed: ${errorName(error)}`);
        }
      } else {
        safeLog(logger, "completeAiCall skipped: invalid token counts");
      }
      return result;
    },
  };
}

/** Fire and forget: an alert must never block or fail the AI call. */
function raise(alert: AlertFn, kind: AlertKind, ticketId: string | undefined): void {
  try {
    const pending = ticketId === undefined ? alert(kind) : alert(kind, { ticketId });
    Promise.resolve(pending).catch(() => undefined);
  } catch {
    // swallowed by design
  }
}

function safeLog(logger: MeterLogger, message: string): void {
  try {
    logger.error(message);
  } catch {
    // logging must not fail the AI call
  }
}
