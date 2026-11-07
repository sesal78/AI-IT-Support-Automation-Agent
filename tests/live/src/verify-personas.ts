// `pnpm --filter @ai-it-support/live-tests verify:personas` (P5-T7): a read-only
// check that dev420188 holds what seed-personas.js and the plan promise. It
// prints item names only, never a value, and exits 1 on any missing item.
import { ASSIGNMENT_GROUPS, CATEGORIES } from "@ai-it-support/shared";
import { errorClassName } from "./client.ts";
import { loadServiceNowConfig, missingServiceNowEnv, type ServiceNowConfig } from "./config.ts";
import { createE2eServiceNow, ServiceNowApiError, type E2eServiceNow } from "./servicenow.ts";

/** The §4.2 personas: user name, exact direct roles and active value. */
export const PERSONAS = [
  { name: "demo.alice", roles: ["snc_internal"], active: true },
  { name: "demo.bob", roles: ["snc_internal"], active: true },
  { name: "demo.carol", roles: ["snc_internal"], active: true },
  { name: "demo.dave", roles: ["snc_internal"], active: true },
  { name: "demo.erin", roles: ["snc_internal"], active: true },
  { name: "demo.frank", roles: ["itil", "snc_internal"], active: true },
  { name: "demo.gina", roles: ["snc_internal"], active: false },
] as const;

const isTrue = (value: string | undefined): boolean => value === "true" || value === "1";

interface Outcome {
  readonly missing: string[];
  readonly notChecked: string[];
  /** True when the run stopped at the first 401 or 403, so the rest was not asked. */
  readonly stopped: boolean;
}

/** Raised after the first refused read: more probes with the same credentials could lock the account. */
class AuthStop extends Error {
  override readonly name = "AuthStop";
}

/** Runs every check and returns the missing and unreadable items by name. */
export async function verifyPersonas(sn: E2eServiceNow): Promise<Outcome> {
  const missing: string[] = [];
  const notChecked: string[] = [];

  // A 401/403 is "this account cannot read it": not a pass, and not a miss either.
  // It also stops the run at once; the rest is never asked with credentials that were refused.
  async function check(item: string, probe: () => Promise<void>): Promise<void> {
    try {
      await probe();
    } catch (error) {
      if (error instanceof ServiceNowApiError && (error.status === 401 || error.status === 403)) {
        notChecked.push(item);
        throw new AuthStop();
      } else {
        throw error;
      }
    }
  }

  try {
    for (const persona of PERSONAS) {
      await check(persona.name, async () => {
        const user = await sn.userByName(persona.name);
        const sysId = user?.["sys_id"];
        if (user === undefined || sysId === undefined) {
          missing.push(`${persona.name}: missing`);
          return;
        }
        if (isTrue(user["active"]) !== persona.active) {
          missing.push(`${persona.name}: ${persona.active ? "inactive" : "active"}`);
        }
        const roles = await sn.userRoles(sysId);
        for (const role of persona.roles) {
          if (!roles.includes(role)) missing.push(`${persona.name}: lacks ${role}`);
        }
        for (const role of roles) {
          if (!(persona.roles as readonly string[]).includes(role)) {
            missing.push(`${persona.name}: extra role ${role}`);
          }
        }
      });
    }

    await check("abel.tuter", async () => {
      if ((await sn.userByName("abel.tuter")) === undefined) missing.push("abel.tuter: missing");
    });

    await check("categories", async () => {
      const found = await sn.incidentCategories();
      for (const category of CATEGORIES) {
        if (!found.includes(category)) missing.push(`category ${category}: missing`);
      }
    });

    for (const group of ASSIGNMENT_GROUPS) {
      await check(`group ${group}`, async () => {
        if ((await sn.groupByName(group)) === undefined) missing.push(`group ${group}: missing`);
      });
    }

    await check("svc.itsupport", async () => {
      const user = await sn.userByName("svc.itsupport");
      const sysId = user?.["sys_id"];
      if (user === undefined || sysId === undefined) {
        missing.push("svc.itsupport: missing");
        return;
      }
      const roles = await sn.userRoles(sysId);
      if (roles.length !== 1 || roles[0] !== "itil")
        missing.push("svc.itsupport: roles not only itil");
    });
  } catch (error) {
    if (!(error instanceof AuthStop)) throw error;
    return { missing, notChecked, stopped: true };
  }

  return { missing, notChecked, stopped: false };
}

export interface VerifyOptions {
  readonly fetch: (input: URL, init: RequestInit) => Promise<Response>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** Exit code: 0 all present, 1 an item is missing, 2 nothing missing but a read was refused or a variable is unset. */
export async function runVerifyPersonas(
  env: Record<string, string | undefined>,
  options: VerifyOptions,
): Promise<number> {
  let config: ServiceNowConfig;
  try {
    config = loadServiceNowConfig(env);
  } catch (error) {
    options.stderr(
      `verify:personas: ${error instanceof Error ? error.message : "bad environment"}`,
    );
    return 1;
  }
  const unset = missingServiceNowEnv({ servicenow: config });
  if (unset.length > 0) {
    options.stderr(`verify:personas: not run, unset: ${unset.join(", ")}`);
    return 2;
  }
  try {
    const { missing, notChecked, stopped } = await verifyPersonas(
      createE2eServiceNow(config, options.fetch),
    );
    for (const item of missing) options.stdout(`missing ${item}`);
    for (const item of notChecked) options.stdout(`not_checked ${item}`);
    if (stopped) options.stdout("stopped: a read was refused, the remaining items were not asked");
    if (missing.length > 0) return 1;
    if (notChecked.length > 0) return 2;
    options.stdout("ok: all personas, categories and groups present");
    return 0;
  } catch (error) {
    // Never print an unknown error's message: it may quote a value.
    options.stderr(`verify:personas: error (${errorClassName(error)})`);
    return 1;
  }
}
