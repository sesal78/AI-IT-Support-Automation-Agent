import { BuiltinConnector, type BuiltinHelpdeskStore } from "./builtin.js";
import { HelpdeskError } from "./errors.js";
import { withShadowMode, type ShadowOptions } from "./shadow.js";
import type { HelpdeskConnector } from "./types.js";

export interface HelpdeskSelectorDeps {
  /** The built-in helpdesk's repositories (`packages/db`). */
  store: BuiltinHelpdeskStore;
  /** Builds the ServiceNow connector. Called only when `HELPDESK=servicenow`. */
  serviceNow: () => HelpdeskConnector;
}

export interface HelpdeskFactoryDeps extends HelpdeskSelectorDeps {
  shadow: ShadowOptions;
  /** Wraps the chosen connector before the shadow wrapper (the e2e asleep switch). */
  decorate?: (connector: HelpdeskConnector) => HelpdeskConnector;
}

/**
 * The connector `HELPDESK` names (G1), not yet wrapped for shadow mode. A value
 * that is not `servicenow` or `builtin` fails closed with a `config` error that
 * does not repeat it; `parseHelpdeskEnv` rejects it at boot first.
 */
export function selectHelpdeskConnector(
  env: { HELPDESK: "servicenow" | "builtin" },
  deps: HelpdeskSelectorDeps,
): HelpdeskConnector {
  switch (env.HELPDESK) {
    case "builtin":
      return new BuiltinConnector(deps.store);
    case "servicenow":
      return deps.serviceNow();
    default:
      throw new HelpdeskError("config", "select");
  }
}

/**
 * The chosen connector wrapped by the shadow wrapper (P5-T4), so the built-in
 * helpdesk gets the same protection as ServiceNow: in shadow mode no write
 * reaches either one.
 */
export function createHelpdeskConnector(
  env: { HELPDESK: "servicenow" | "builtin" },
  deps: HelpdeskFactoryDeps,
): HelpdeskConnector {
  const chosen = selectHelpdeskConnector(env, deps);
  return withShadowMode(deps.decorate ? deps.decorate(chosen) : chosen, deps.shadow);
}
