import {
  InstanceAsleepError,
  type HelpdeskConnector,
  type HelpdeskHealth,
} from "@ai-it-support/helpdesk";

const MINUTE_MS = 60_000;

/** The `helpdeskAsleepMinutes` switch: `created_at` plus the minutes, in epoch ms. */
export function asleepUntil(createdAt: string, minutes: number): number {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) throw new TypeError("createdAt must be a date");
  return created + minutes * MINUTE_MS;
}

export interface AsleepSwitchOptions {
  /** Epoch ms. The connector acts asleep while `now()` is before it. */
  asleepUntil: number;
  now: () => number;
}

/**
 * Test switch (plan C5): until the given time every call throws the same
 * `InstanceAsleepError` a sleeping instance gives, and `health` says `asleep`.
 * The wrapped connector is not called. From the exact time on, calls pass through.
 */
export function withAsleepSwitch(
  connector: HelpdeskConnector,
  options: AsleepSwitchOptions,
): HelpdeskConnector {
  const asleep = (): boolean => options.now() < options.asleepUntil;
  const guard =
    <Args extends unknown[], Result>(operation: string, call: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      if (asleep()) throw new InstanceAsleepError(operation);
      return call(...args);
    };
  return {
    kind: connector.kind,
    createTicket: guard("createTicket", (input) => connector.createTicket(input)),
    findByExternalRef: guard("findByExternalRef", (ticketId) =>
      connector.findByExternalRef(ticketId),
    ),
    addNote: guard("addNote", (ref, body) => connector.addNote(ref, body)),
    updateTicket: guard("updateTicket", (ref, update) => connector.updateTicket(ref, update)),
    health: async (): Promise<HelpdeskHealth> =>
      asleep() ? { status: "asleep" } : connector.health(),
  };
}
