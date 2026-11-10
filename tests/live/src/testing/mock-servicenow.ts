// A fetch-level mock of the dev420188 Table API for the P5-T7 tests: it answers
// the GET queries the helper builds, records every request, and never opens a socket.
import { ASSIGNMENT_GROUPS, CATEGORIES } from "@ai-it-support/shared";

export const SN_URL = "https://dev420188.service-now.com";
export const SN_PASSWORD = `MarkerSnPassword${"q".repeat(20)}`;
export const SN_USER = "svc.itsupport";
export const sysId = (n: number) => String(n).padStart(32, "0");

type Row = Record<string, string>;
export interface MockSnData {
  users: Row[];
  /** user sys_id -> direct role names */
  roles: Record<string, string[]>;
  groups: string[];
  categories: string[];
  incidents: Row[];
  journal: Row[];
}

export const PERSONA_ROLES: Record<string, string[]> = {
  "demo.alice": ["snc_internal"],
  "demo.bob": ["snc_internal"],
  "demo.carol": ["snc_internal"],
  "demo.dave": ["snc_internal"],
  "demo.erin": ["snc_internal"],
  "demo.frank": ["itil", "snc_internal"],
  "demo.gina": ["snc_internal"],
  "abel.tuter": ["snc_internal"],
  "svc.itsupport": ["itil"],
};

/** A complete, correct instance: every persona, group and category present. */
export function fullInstance(): MockSnData {
  const users = Object.keys(PERSONA_ROLES).map((user_name, i) => ({
    sys_id: sysId(i + 1),
    user_name,
    active: user_name === "demo.gina" ? "false" : "true",
    locked_out: "false",
    email: `${user_name}@example.com`,
  }));
  return {
    users,
    roles: Object.fromEntries(users.map((u) => [u.sys_id!, [...PERSONA_ROLES[u.user_name!]!]])),
    groups: [...ASSIGNMENT_GROUPS],
    categories: [...CATEGORIES],
    incidents: [],
    journal: [],
  };
}

const stringify = (body: Record<string, unknown>): Row =>
  Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));

export interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly init: RequestInit;
}

export function mockServiceNow(
  data: MockSnData,
  options: { denyRoles?: boolean; denyAll?: number; keepOpen?: boolean } = {},
) {
  const requests: Recorded[] = [];
  const fetchImpl = async (input: URL, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    requests.push({ method, url: input, init });
    if (options.denyAll !== undefined) {
      return new Response(JSON.stringify({ error: "denied" }), { status: options.denyAll });
    }
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const table = input.pathname.replace("/api/now/table/", "");
    if (method === "POST") {
      // The connector's create: the row gets the fields the helper reads back.
      const n = data.incidents.length + 1;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const row: Row = { assignment_group: "", state: "1", ...stringify(body) };
      row["sys_id"] = sysId(900 + n);
      row["number"] = `INC${String(n).padStart(7, "0")}`;
      data.incidents.push(row);
      return json({ result: { sys_id: row["sys_id"], number: row["number"] } }, 201);
    }
    if (method === "PATCH") {
      const id = table.split("/")[1]!;
      const row = data.incidents.find((r) => r["sys_id"] === id);
      if (row === undefined) return json({}, 404);
      const patch = stringify(JSON.parse(String(init.body)));
      // keepOpen: the instance says OK but never closes (T5.C.02 failure path).
      if (!(options.keepOpen && patch["state"] === "7")) Object.assign(row, patch);
      return json({ result: row });
    }
    const terms = Object.fromEntries(
      (input.searchParams.get("sysparm_query") ?? "")
        .split("^")
        .map((t) => t.split("=") as [string, string]),
    );
    let rows: Row[] = [];
    if (table === "sys_user")
      rows = data.users.filter((u) => u["user_name"] === terms["user_name"]);
    else if (table === "sys_user_has_role") {
      if (options.denyRoles) return json({ error: "denied" }, 403);
      rows = (data.roles[terms["user"] ?? ""] ?? []).map((name) => ({ "role.name": name }));
    } else if (table === "sys_user_group") {
      rows = data.groups.filter((g) => g === terms["name"]).map((name) => ({ sys_id: "1", name }));
    } else if (table === "sys_choice") rows = data.categories.map((value) => ({ value }));
    else if (table === "incident") {
      rows = data.incidents.filter((r) =>
        terms["sys_id"] !== undefined
          ? r["sys_id"] === terms["sys_id"]
          : r["correlation_id"] ===
            (terms["correlation_id"] ?? input.searchParams.get("correlation_id")),
      );
    } else if (table === "sys_journal_field")
      rows = data.journal.filter((r) => r["element_id"] === terms["element_id"]);
    return json({ result: rows });
  };
  return { fetch: fetchImpl, requests };
}
