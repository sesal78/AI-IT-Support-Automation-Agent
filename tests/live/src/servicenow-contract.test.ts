// T5.C.02 (P5-T3b) against the fetch-level mock only: dev420188 is never reached here.
import { describe, expect, it } from "vitest";
import type { ScenarioContext } from "./runner.ts";
import { serviceNowContractScenario } from "./servicenow-contract.ts";
import {
  fullInstance,
  mockServiceNow,
  SN_PASSWORD,
  SN_URL,
  SN_USER,
} from "./testing/mock-servicenow.ts";

function context(fetch: ScenarioContext["fetch"], unset: "password" | null = null) {
  const servicenow = { instanceUrl: SN_URL, username: SN_USER, password: SN_PASSWORD };
  if (unset) Object.assign(servicenow, { [unset]: undefined });
  return { config: { servicenow }, fetch } as unknown as ScenarioContext;
}

describe("T5.C.02", () => {
  it("runs every contract case, then closes every incident it created", async () => {
    const data = fullInstance();
    const mock = mockServiceNow(data);
    const result = await serviceNowContractScenario.run(context(mock.fetch));

    expect(result.status).toBe("pass");
    expect(data.incidents.length).toBeGreaterThan(0);
    expect(data.incidents.every((i) => i["state"] === "7")).toBe(true);
    expect(data.incidents.every((i) => i["short_description"]?.startsWith("[E2E] "))).toBe(true);
    const closes = mock.requests.filter(
      (r) => r.method === "PATCH" && String(r.init.body).includes('"state":"7"'),
    );
    expect(closes).toHaveLength(data.incidents.length);
    expect(result.evidence).toMatchObject({
      created: data.incidents.length,
      open: 0,
      failedCases: 0,
      aiCallCount: 0,
    });
  });

  it("fails when the instance keeps an incident open after cleanup", async () => {
    const data = fullInstance();
    const mock = mockServiceNow(data, { keepOpen: true });
    const result = await serviceNowContractScenario.run(context(mock.fetch));

    expect(result.status).toBe("fail");
    expect(result.evidence?.["open"]).toBe(data.incidents.length);
  });

  it("is not_run when a ServiceNow variable is unset, with no request", async () => {
    const mock = mockServiceNow(fullInstance());
    const result = await serviceNowContractScenario.run(context(mock.fetch, "password"));
    expect(result).toEqual({
      status: "not_run",
      evidence: { missing: ["E2E_SERVICENOW_PASSWORD"] },
    });
    expect(mock.requests).toEqual([]);
  });
});
