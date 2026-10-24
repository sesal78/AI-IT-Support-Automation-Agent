import type { MeterProvider, MeterRunOptions, TokenUsage } from "./meter.js";

/** One traced AI call. Privacy: `input` and `output` must hold redacted text only. */
export interface TraceSpan {
  ticketId?: string | undefined;
  provider: MeterProvider;
  kind: string;
  model: string;
  input: unknown;
  output?: unknown;
  /** null when `fn` failed before it reported usage. */
  tokensIn: number | null;
  tokensOut: number | null;
  startTime: Date;
  endTime: Date;
  environment: string;
  /** Error class name only, never the message. */
  error?: string | undefined;
}

export interface TraceSink {
  record(span: TraceSpan): Promise<void>;
}

/** A sink could not export a span. The message never holds a body, a header or a key. */
export class TraceExportError extends Error {
  constructor(reason: string) {
    super(`Trace export failed: ${reason}`);
    this.name = "TraceExportError";
  }
}

export interface AiRuntimeMeter {
  run<T extends TokenUsage>(options: MeterRunOptions, fn: () => Promise<T>): Promise<T>;
}

export interface AiRuntimeLogger {
  error(message: string): void;
}

export interface AiRuntimeDeps {
  meter: AiRuntimeMeter;
  sink: TraceSink;
  /** Appends a ticket event (packages/db `addEvent`). */
  addEvent: (ticketId: string, type: string, payload: Record<string, unknown>) => Promise<unknown>;
  /** The span's environment, `e2e` or `staging`. */
  environment: string;
  /** Defaults to console.error. Receives error class names only. */
  logger?: AiRuntimeLogger;
  now?: () => Date;
}

export interface AiCallMeta extends MeterRunOptions {
  model: string;
  /**
   * The object `fn` sends to the provider. It is recorded as is, so callers
   * must build it from redacted text only; the runtime adds no ticket text.
   */
  input: unknown;
}

const CLASS_NAME = /^[A-Za-z0-9_$]{1,64}$/;

/** Class name only. A non-Error value gives its typeof; an odd name gives "Error". */
export function errorClassName(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const name: unknown = error.constructor?.name;
  if (typeof name === "string" && CLASS_NAME.test(name)) return name;
  return CLASS_NAME.test(error.name) ? error.name : "Error";
}

function safeLog(logger: AiRuntimeLogger, message: string): void {
  try {
    logger.error(message);
  } catch {
    // logging must not fail the AI call
  }
}

/**
 * Metered AI calls with one trace span per allowed reservation.
 * - A refused or failed reservation never runs `fn` and records no span, so
 *   the span count equals the `ai_calls` row count.
 * - The span is recorded after `fn` settles, also when `fn` threw; the error
 *   is then rethrown untouched.
 * - A failing sink never fails the call: the runtime adds the ticket event
 *   `trace_export_failed` ({ kind }), or only logs when there is no ticket.
 */
export function createAiRuntime(deps: AiRuntimeDeps) {
  const { meter, sink, addEvent, environment } = deps;
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());

  async function exportSpan(span: TraceSpan): Promise<void> {
    try {
      await sink.record(span);
    } catch (error) {
      safeLog(logger, `trace export failed: ${errorClassName(error)}`);
      if (span.ticketId === undefined) return;
      try {
        await addEvent(span.ticketId, "trace_export_failed", { kind: span.kind });
      } catch (eventError) {
        safeLog(logger, `trace_export_failed event failed: ${errorClassName(eventError)}`);
      }
    }
  }

  return {
    async call<T extends TokenUsage & { output?: unknown }>(
      meta: AiCallMeta,
      fn: () => Promise<T>,
    ): Promise<T> {
      const { model, input, ...runOptions } = meta;
      let startTime: Date | undefined;
      let failed: { error: unknown } | undefined;

      const span = (extra: Partial<TraceSpan>): TraceSpan => ({
        ticketId: meta.ticketId,
        provider: meta.provider,
        kind: meta.kind,
        model,
        input,
        tokensIn: null,
        tokensOut: null,
        startTime: startTime as Date,
        endTime: now(),
        environment,
        ...extra,
      });

      try {
        const result = await meter.run(runOptions, async () => {
          startTime = now();
          try {
            return await fn();
          } catch (error) {
            failed = { error };
            throw error;
          }
        });
        await exportSpan(
          span({ output: result.output, tokensIn: result.tokensIn, tokensOut: result.tokensOut }),
        );
        return result;
      } catch (error) {
        // `startTime` is set only when the reservation was allowed and `fn` ran.
        if (startTime !== undefined && failed !== undefined) {
          await exportSpan(span({ error: errorClassName(failed.error) }));
        }
        throw error;
      }
    },
  };
}
