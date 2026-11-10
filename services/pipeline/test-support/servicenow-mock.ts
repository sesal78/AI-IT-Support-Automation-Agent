// A small in-memory ServiceNow Table API for pipeline integration tests (P5-T5a),
// served through the egress recorder (msw). TEST CODE ONLY. Nothing here reaches
// a real instance: the origin is a made-up host and the recorder blocks anything
// that is not mocked.
import { HttpResponse, delay } from "msw";
import type { EgressRecorder } from "../../../packages/shared/test-support/egress-recorder.js";

export const SERVICENOW_ORIGIN = "https://itsupport-test.service-now.com";
export const SERVICENOW_HOST = new URL(SERVICENOW_ORIGIN).host;
export const SYS_USER_LOOKUP_PATH = "/api/now/table/sys_user";
export const DEFAULT_CALLER = "d".repeat(32);

/** The pipeline's ServiceNow env for the mock. The password is built from pieces (gitleaks). */
export const SERVICENOW_ENV = {
  SERVICENOW_INSTANCE_URL: SERVICENOW_ORIGIN,
  SERVICENOW_USERNAME: "svc.itsupport",
  SERVICENOW_PASSWORD: ["Mock", "Sn", "Pw", "-0123456789"].join(""),
  SERVICENOW_DEFAULT_CALLER: DEFAULT_CALLER,
};

const HIBERNATING = "<html><body><h1>Instance Hibernating</h1></body></html>";

type Row = Record<string, string>;
type Kind =
  "GET incident" | "POST incident" | "PATCH incident" | "GET sys_user" | "GET sys_user_group";

/** What the next matching request gets instead of the normal answer. */
export type Fault =
  | { status: number }
  | "timeout"
  | "asleep"
  /** The incident is created, then the response never arrives. */
  | "lose-response";

export interface ServiceNowMock {
  incidents: Row[];
  users: Row[];
  groups: Row[];
  /** Faults for requests of one kind, used in order, one per request. */
  fail(kind: Kind, ...faults: Fault[]): void;
  /** Every request while this is on gets the hibernation page. */
  setAsleep(asleep: boolean): void;
  reset(): void;
}

/** Registers the mock on the recorder and returns its state. */
export function mockServiceNow(recorder: EgressRecorder): ServiceNowMock {
  const faults = new Map<Kind, Fault[]>();
  let asleep = false;
  const mock: ServiceNowMock = {
    incidents: [],
    users: [],
    groups: [],
    fail(kind, ...next) {
      faults.set(kind, [...(faults.get(kind) ?? []), ...next]);
    },
    setAsleep(value) {
      asleep = value;
    },
    reset() {
      mock.incidents.length = 0;
      mock.users.length = 0;
      mock.groups.length = 0;
      faults.clear();
      asleep = false;
    },
  };
  const json = (result: unknown, status = 200) => HttpResponse.json({ result }, { status });

  recorder.mock(SERVICENOW_ORIGIN, async ({ request }) => {
    if (asleep) return new HttpResponse(HIBERNATING, { headers: { "content-type": "text/html" } });
    const url = new URL(request.url);
    const [table = "", sysId] = url.pathname.replace("/api/now/table/", "").split("/");
    const kind = `${request.method} ${table}` as Kind;
    const fault = faults.get(kind)?.shift();
    if (fault === "asleep") {
      return new HttpResponse(HIBERNATING, { headers: { "content-type": "text/html" } });
    }
    if (fault === "timeout") await delay("infinite");
    if (typeof fault === "object") return new HttpResponse("", { status: fault.status });

    const params = url.searchParams;
    if (request.method === "POST") {
      const body = (await request.json()) as Row;
      const number = `INC${String(mock.incidents.length + 1).padStart(7, "0")}`;
      const row = { ...body, sys_id: String(mock.incidents.length + 1).padStart(32, "0"), number };
      mock.incidents.push(row);
      if (fault === "lose-response") await delay("infinite");
      return json({ sys_id: row.sys_id, number }, 201);
    }
    if (request.method === "PATCH") {
      const row = mock.incidents.find((r) => r.sys_id === sysId);
      return row ? json(Object.assign(row, await request.json())) : json({}, 404);
    }
    if (table === "sys_user")
      return json(mock.users.filter((u) => u.email === params.get("email")));
    if (table === "sys_user_group") {
      return json(mock.groups.filter((g) => g.name === params.get("name")));
    }
    return json(mock.incidents.filter((r) => r.correlation_id === params.get("correlation_id")));
  });
  return mock;
}
