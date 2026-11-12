import { describe, expect, it } from "vitest";
import type { ServiceNowConfig } from "./config.ts";
import {
  createE2eServiceNow,
  INCIDENT_PAGE_LIMIT,
  ServiceNowApiError,
  ServiceNowGuardError,
  serviceNowStamp,
} from "./servicenow.ts";
import {
  fullInstance,
  mockServiceNow,
  SN_PASSWORD,
  SN_URL,
  SN_USER,
  sysId,
} from "./testing/mock-servicenow.ts";

const config: ServiceNowConfig = { instanceUrl: SN_URL, username: SN_USER, password: SN_PASSWORD };
const TICKET = "11111111-2222-3333-4444-555555555555";
const SINCE = Date.parse("2026-11-13T00:00:00Z");

function incident(short: string, id = sysId(900)) {
  return {
    sys_id: id,
    number: "INC0010001",
    category: "hardware",
    caller_id: sysId(1),
    assignment_group: sysId(2),
    short_description: short,
    description: "d",
    state: "1",
    correlation_id: TICKET,
    correlation_display: "ITS-000001",
    sys_created_on: "2026-11-13 00:00:00",
  };
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return `${(error as Error).name} ${(error as Error).message} ${(error as Error).stack ?? ""}`;
  }
  throw new Error("expected a rejection");
}

describe("createE2eServiceNow", () => {
  it.each([
    "https://other.service-now.com",
    "https://dev420188.service-now.com/",
    "http://dev420188.service-now.com",
    "https://DEV420188.service-now.com",
    "https://dev420188.service-now.com.evil.example",
  ])("sn helper refuses instance URL %s before any request", async (instanceUrl) => {
    const mock = mockServiceNow(fullInstance());
    const sn = createE2eServiceNow({ ...config, instanceUrl }, mock.fetch);
    await expect(sn.userByName("demo.alice")).rejects.toMatchObject({ reason: "wrong_instance" });
    await expect(sn.closeIncident(sysId(900))).rejects.toBeInstanceOf(ServiceNowGuardError);
    expect(mock.requests).toEqual([]);
  });

  it("sn helper refuses an unset variable before any request", async () => {
    const mock = mockServiceNow(fullInstance());
    const sn = createE2eServiceNow({ ...config, password: undefined }, mock.fetch);
    await expect(sn.incidentCategories()).rejects.toMatchObject({ reason: "config_missing" });
    expect(mock.requests).toEqual([]);
  });

  it("sn helper reads incidents, work notes, users, roles, groups and categories with GET only", async () => {
    const data = fullInstance();
    data.incidents.push(incident("[E2E] printer"));
    data.journal.push({ element_id: sysId(900), value: "note one" });
    const mock = mockServiceNow(data);
    const sn = createE2eServiceNow(config, mock.fetch);
    const found = await sn.incidentsByCorrelationId(TICKET);
    expect(found.map((i) => i.number)).toEqual(["INC0010001"]);
    expect(await sn.workNotes(sysId(900))).toEqual(["note one"]);
    const frank = await sn.userByName("demo.frank");
    expect(await sn.userRoles(frank!["sys_id"]!)).toEqual(["itil", "snc_internal"]);
    expect(await sn.userByName("nobody.here")).toBeUndefined();
    expect((await sn.groupByName("Service Desk"))?.["name"]).toBe("Service Desk");
    expect(await sn.incidentCategories()).toContain("password_reset");
    expect(mock.requests.length).toBe(7);
    expect(mock.requests.every((r) => r.method === "GET")).toBe(true);
    const first = mock.requests[0]!;
    expect(first.url.origin).toBe(SN_URL);
    expect(first.init.redirect).toBe("manual");
  });

  it("sn helper rejects a value that would change the query", async () => {
    const mock = mockServiceNow(fullInstance());
    const sn = createE2eServiceNow(config, mock.fetch);
    await expect(sn.userByName("demo.alice^active=false")).rejects.toMatchObject({
      reason: "bad_argument",
    });
    await expect(sn.groupByName("a^b")).rejects.toMatchObject({ reason: "bad_argument" });
    await expect(sn.incidentsByCorrelationId("x^y")).rejects.toMatchObject({
      reason: "bad_argument",
    });
    await expect(sn.workNotes("short")).rejects.toMatchObject({ reason: "bad_argument" });
    expect(mock.requests).toEqual([]);
  });

  it("sn closeIncident on an incident without [E2E] is refused after the re-read and sends no PATCH", async () => {
    const data = fullInstance();
    data.incidents.push(incident("Real user printer problem"));
    const mock = mockServiceNow(data);
    const sn = createE2eServiceNow(config, mock.fetch);
    await expect(sn.closeIncident(sysId(900))).rejects.toMatchObject({
      reason: "not_e2e_incident",
    });
    expect(mock.requests.map((r) => r.method)).toEqual(["GET"]);
    expect(data.incidents[0]!["state"]).toBe("1");
  });

  it("sn closeIncident on a missing incident is refused and sends no PATCH", async () => {
    const mock = mockServiceNow(fullInstance());
    const sn = createE2eServiceNow(config, mock.fetch);
    await expect(sn.closeIncident(sysId(901))).rejects.toMatchObject({
      reason: "not_e2e_incident",
    });
    expect(mock.requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("sn closeIncident closes an [E2E] incident with one PATCH, the only non-GET request", async () => {
    const data = fullInstance();
    data.incidents.push(incident("[E2E] printer"));
    const mock = mockServiceNow(data);
    const sn = createE2eServiceNow(config, mock.fetch);
    await sn.closeIncident(sysId(900));
    expect(mock.requests.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    expect(data.incidents[0]!["state"]).toBe("7");
    expect(data.incidents[0]!["close_code"]).toBe("Closed/Resolved by Caller");
  });

  it("sn helper: no method other than closeIncident sends a non-GET request", async () => {
    const data = fullInstance();
    data.incidents.push(incident("[E2E] printer"));
    const mock = mockServiceNow(data);
    const sn = createE2eServiceNow(config, mock.fetch);
    await sn.incidentsByCorrelationId(TICKET);
    await sn.workNotes(sysId(900));
    await sn.userByName("demo.alice");
    await sn.userRoles(sysId(1));
    await sn.groupByName("Hardware");
    await sn.incidentCategories();
    expect(mock.requests.some((r) => r.method !== "GET")).toBe(false);
  });

  it("sn helper: with the password set to a marker, no error, stack or request URL holds it", async () => {
    const encoded = Buffer.from(`${SN_USER}:${SN_PASSWORD}`).toString("base64");
    const echoing = async (_input: URL, init: RequestInit) =>
      new Response(JSON.stringify({ error: { message: `${SN_PASSWORD} ${encoded}` } }), {
        status: 500,
        statusText: SN_PASSWORD,
        headers: { "x-echo": String(init.headers) },
      });
    const garbled = async () => new Response(`${SN_PASSWORD} not json`, { status: 200 });
    const failing = async () => {
      throw new Error(`socket ${SN_PASSWORD}`);
    };
    const wrongShape = async () =>
      new Response(JSON.stringify({ result: SN_PASSWORD }), { status: 200 });
    for (const impl of [echoing, garbled, failing, wrongShape]) {
      const sn = createE2eServiceNow(config, impl);
      for (const call of [
        () => sn.userByName("demo.alice"),
        () => sn.incidentCategories(),
        () => sn.closeIncident(sysId(900)),
      ]) {
        const text = await messageOf(call());
        expect(text).not.toContain(SN_PASSWORD);
        expect(text).not.toContain(encoded);
      }
    }
    const mock = mockServiceNow(fullInstance());
    await createE2eServiceNow(config, mock.fetch).userByName("demo.alice");
    expect(mock.requests.map((r) => r.url.href).join("\n")).not.toContain(SN_PASSWORD);
    expect(
      await messageOf(createE2eServiceNow(config, echoing).userByName("demo.alice")),
    ).toContain("ServiceNowApiError");
  });

  it("sn helper reports a refused read as an API error naming the status only", async () => {
    const data = fullInstance();
    const sn = createE2eServiceNow(config, mockServiceNow(data, { denyRoles: true }).fetch);
    const error = await sn.userRoles(sysId(1)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceNowApiError);
    expect((error as ServiceNowApiError).status).toBe(403);
    expect((error as Error).message).toBe("userRoles: status 403");
  });
});

describe("e2eIncidentsSince (P5-T5c, T5.O.01)", () => {
  it("asks for [E2E] rows since the run start, with one GET and a fixed query", async () => {
    const data = fullInstance();
    data.incidents.push(incident("[E2E] printer"));
    data.incidents.push({
      ...incident("[E2E] older", sysId(901)),
      sys_created_on: "2026-11-12 23:59:59",
    });
    data.incidents.push({ ...incident("Real user printer", sysId(902)) });
    const mock = mockServiceNow(data);
    const page = await createE2eServiceNow(config, mock.fetch).e2eIncidentsSince(SINCE);

    expect(page).toMatchObject({ truncated: false });
    expect(page.incidents.map((i) => i.sys_id)).toEqual([sysId(900)]);
    expect(mock.requests).toHaveLength(1);
    const request = mock.requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.url.searchParams.get("sysparm_query")).toBe(
      "short_descriptionSTARTSWITH[E2E]^sys_created_on>=2026-11-13 00:00:00",
    );
    expect(request.url.searchParams.get("sysparm_limit")).toBe(String(INCIDENT_PAGE_LIMIT));
  });

  it("retains correlation_display and sys_created_on for the reconciliation", async () => {
    const data = fullInstance();
    data.incidents.push(incident("[E2E] printer"));
    const { incidents } = await createE2eServiceNow(
      config,
      mockServiceNow(data).fetch,
    ).e2eIncidentsSince(SINCE);
    expect(incidents[0]).toMatchObject({
      correlation_display: "ITS-000001",
      sys_created_on: "2026-11-13 00:00:00",
    });
  });

  it("reports a full page as truncated, never as the whole list", async () => {
    const data = fullInstance();
    for (let i = 0; i < INCIDENT_PAGE_LIMIT; i++) {
      data.incidents.push({
        ...incident("[E2E] many", sysId(1_000 + i)),
        correlation_id: TICKET,
      });
    }
    const page = await createE2eServiceNow(config, mockServiceNow(data).fetch).e2eIncidentsSince(
      SINCE,
    );
    expect(page.incidents).toHaveLength(INCIDENT_PAGE_LIMIT);
    expect(page.truncated).toBe(true);
  });

  it("refuses a since value that is not a finite number, before any request", async () => {
    const mock = mockServiceNow(fullInstance());
    const sn = createE2eServiceNow(config, mock.fetch);
    await expect(sn.e2eIncidentsSince(Number.NaN)).rejects.toBeInstanceOf(ServiceNowGuardError);
    expect(mock.requests).toEqual([]);
    expect(() => serviceNowStamp(Number.POSITIVE_INFINITY)).toThrow(ServiceNowGuardError);
  });

  it("never builds a query from a value: the stamp holds no query syntax", () => {
    expect(serviceNowStamp(SINCE)).toBe("2026-11-13 00:00:00");
    expect(serviceNowStamp(SINCE + 999)).toBe("2026-11-13 00:00:00");
  });
});

describe("mock ServiceNow failure paths (test support)", () => {
  it("answers a refused incident read with that status", async () => {
    const data = fullInstance();
    const sn = createE2eServiceNow(config, mockServiceNow(data, { denyIncidentRead: 503 }).fetch);
    const error = await sn.incidentsByCorrelationId(TICKET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceNowApiError);
    expect((error as ServiceNowApiError).status).toBe(503);
  });

  it("answers a refused close with that status and leaves the incident open", async () => {
    const data = fullInstance();
    data.incidents.push(incident("[E2E] printer"));
    const sn = createE2eServiceNow(config, mockServiceNow(data, { denyClose: 503 }).fetch);
    await expect(sn.closeIncident(sysId(900))).rejects.toBeInstanceOf(ServiceNowApiError);
    expect(data.incidents[0]!["state"]).toBe("1");
  });

  it("stamps a created incident with the mock clock", async () => {
    const data = fullInstance();
    const mock = mockServiceNow(data, { now: () => SINCE });
    await mock.fetch(new URL("/api/now/table/incident", SN_URL), {
      method: "POST",
      body: JSON.stringify({ short_description: "[E2E] x", correlation_id: TICKET }),
    });
    expect(data.incidents[0]!["sys_created_on"]).toBe("2026-11-13 00:00:00");
  });
});
