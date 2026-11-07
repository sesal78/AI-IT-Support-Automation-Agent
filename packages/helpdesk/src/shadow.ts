import type { HelpdeskConnector, HelpdeskHealth, HelpdeskTicketRef, ShadowSkip } from "./types.js";

/** The write operations shadow mode skips. */
export type ShadowOperation = "create" | "note" | "update";

export interface ShadowOptions {
  enabled: boolean;
  /** Called once per skipped write with the operation name only, never ticket text. */
  log?: (event: "shadow_skipped", fields: { operation: ShadowOperation }) => void;
}

/**
 * Shadow mode: when `enabled`, every write is skipped and the inner connector
 * is never called for it; reads (`findByExternalRef`, `health`) pass through.
 * Only exactly `false` returns the connector unchanged; any other value fails closed.
 */
export function withShadowMode(
  connector: HelpdeskConnector,
  options: ShadowOptions,
): HelpdeskConnector {
  if (options.enabled === false) return connector;
  const skip = (operation: ShadowOperation): ShadowSkip => {
    options.log?.("shadow_skipped", { operation });
    return { skipped: "shadow" };
  };
  return {
    kind: connector.kind,
    createTicket: () => Promise.resolve(skip("create")),
    addNote: () => Promise.resolve(skip("note")),
    updateTicket: () => Promise.resolve(skip("update")),
    findByExternalRef: (ticketId: string): Promise<HelpdeskTicketRef | null> =>
      connector.findByExternalRef(ticketId),
    health: (): Promise<HelpdeskHealth> => connector.health(),
  };
}

/**
 * True when the `SHADOW_MODE` env flag is on, or when the effective test
 * overrides (already gated by `effectiveTestOverrides`: E2E mode and a test
 * ticket) ask for it. A switch can turn shadow mode on, never off.
 */
export function shadowEnabled(input: {
  env: { SHADOW_MODE: boolean };
  overrides: { shadowMode?: true };
}): boolean {
  return input.env.SHADOW_MODE === true || input.overrides.shadowMode === true;
}
