// T5.C.02 (P5-T3b): the helpdesk contract suite against ServiceNow, with cleanup.
// It creates [E2E] incidents only (isTest) and closes every one it created through
// the guarded helper; a created incident that is still open afterwards fails the run.
import {
  ServiceNowConnector,
  createServiceNowClient,
  type HelpdeskTicketRef,
} from "@ai-it-support/helpdesk";
import { helpdeskContractCases } from "@ai-it-support/helpdesk/testing";
import { missingServiceNowEnv } from "./config.ts";
import type { Scenario, ScenarioResult } from "./runner.ts";
import { createE2eServiceNow } from "./servicenow.ts";

const CLOSED = "7";

export const serviceNowContractScenario: Scenario = {
  id: "T5.C.02",
  async run(ctx): Promise<ScenarioResult> {
    const missing = missingServiceNowEnv(ctx.config);
    if (missing.length > 0) return { status: "not_run", evidence: { missing } };
    const { instanceUrl, username, password } = ctx.config.servicenow;
    if (instanceUrl === undefined || username === undefined || password === undefined) {
      return { status: "not_run", evidence: { missing } };
    }

    const sn = createE2eServiceNow(ctx.config.servicenow, ctx.fetch);
    // The default caller is the integration user itself (resolved point 8).
    const caller = await sn.userByName(username);
    if (caller === undefined) return { status: "fail", evidence: { reason: "no_default_caller" } };
    const connector = new ServiceNowConnector({
      client: createServiceNowClient({
        instanceUrl,
        username,
        password,
        fetch: ((url, init) => ctx.fetch(new URL(String(url)), init ?? {})) as typeof fetch,
      }),
      defaultCaller: caller["sys_id"] ?? "",
    });
    const ticketIds: string[] = [];
    const create = connector.createTicket.bind(connector);
    connector.createTicket = (input) => {
      ticketIds.push(input.ticketId);
      return create(input);
    };

    let failedCases = 0;
    let cleanupErrors = 0;
    async function close(sysId: string) {
      try {
        await sn.closeIncident(sysId);
      } catch {
        cleanupErrors += 1;
      }
    }
    for (const testCase of helpdeskContractCases(true)) {
      const created: HelpdeskTicketRef[] = [];
      try {
        await testCase.run(connector, created);
      } catch {
        failedCases += 1;
      }
      for (const ref of created) await close(ref.externalId);
    }

    // A create can succeed remotely but return an invalid response. Find those
    // incidents by the ID recorded before the request, and retry any failed close.
    for (const ticketId of ticketIds) {
      try {
        for (const incident of await sn.incidentsByCorrelationId(ticketId)) {
          if (incident.state !== CLOSED) await close(incident.sys_id);
        }
      } catch {
        cleanupErrors += 1;
      }
    }

    let open = 0;
    for (const ticketId of ticketIds) {
      try {
        for (const incident of await sn.incidentsByCorrelationId(ticketId)) {
          if (incident.state !== CLOSED) open += 1;
        }
      } catch {
        cleanupErrors += 1;
      }
    }
    return {
      status: failedCases === 0 && cleanupErrors === 0 && open === 0 ? "pass" : "fail",
      evidence: { created: ticketIds.length, failedCases, cleanupErrors, open, aiCallCount: 0 },
    };
  },
};
