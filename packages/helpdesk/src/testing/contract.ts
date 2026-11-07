import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelpdeskError } from "../errors.js";
import type {
  CreateHelpdeskTicketInput,
  CreatedHelpdeskTicket,
  HelpdeskConnector,
  HelpdeskTicketRef,
  ShadowSkip,
} from "../types.js";

export interface HelpdeskContractOptions {
  /** Runs after each case; a live connector closes the tickets it created. */
  cleanup?: (connector: HelpdeskConnector, created: HelpdeskTicketRef[]) => Promise<void>;
  isTest?: boolean;
}

export interface ContractCase {
  name: string;
  run: (connector: HelpdeskConnector, created: HelpdeskTicketRef[]) => Promise<void>;
}

const RAW_MARKER = "MARKER-RAW-DESCRIPTION-7f3a";
const NAME_MARKER = "MARKER-REQUESTER-NAME-9c1d";

function input(isTest: boolean, extra: object = {}): CreateHelpdeskTicketInput {
  return {
    ticketId: randomUUID(),
    isTest,
    redactedTitle: "[E2E] Printer offline",
    redactedDescription: "The printer on level 2 is offline.",
    category: "hardware",
    priority: "medium",
    assignmentGroup: null,
    requesterEmail: null,
    ...extra,
  };
}

function expectCreated(result: CreatedHelpdeskTicket | ShadowSkip): CreatedHelpdeskTicket {
  if ("skipped" in result) throw new Error("create was skipped by shadow mode");
  return result;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

/** The cases, as data, so a test can run one against a deliberately broken connector. */
export function helpdeskContractCases(isTest = true): ContractCase[] {
  const create = async (c: HelpdeskConnector, created: HelpdeskTicketRef[], extra?: object) => {
    const body = input(isTest, extra);
    const ref = expectCreated(await c.createTicket(body));
    created.push(ref);
    return { body, ref };
  };
  return [
    {
      name: "create returns a ref with a non-empty externalId and number",
      run: async (c, created) => {
        const { ref } = await create(c, created);
        expect(ref.externalId.length).toBeGreaterThan(0);
        expect(ref.number.length).toBeGreaterThan(0);
        expect(typeof ref.callerDefaulted).toBe("boolean");
      },
    },
    {
      name: "findByExternalRef returns the same ref",
      run: async (c, created) => {
        const { body, ref } = await create(c, created);
        expect(await c.findByExternalRef(body.ticketId)).toEqual({
          externalId: ref.externalId,
          number: ref.number,
        });
      },
    },
    {
      name: "findByExternalRef of an unknown ticket ID returns null",
      run: async (c) => {
        expect(await c.findByExternalRef(randomUUID())).toBeNull();
      },
    },
    {
      name: "addNote on the ref resolves",
      run: async (c, created) => {
        const { ref } = await create(c, created);
        await expect(c.addNote(ref, "Checked the cable.")).resolves.not.toThrow();
      },
    },
    {
      name: "addNote on an unknown ref rejects with not_found",
      run: async (c) => {
        const error = await rejection(
          c.addNote({ externalId: randomUUID().replaceAll("-", ""), number: "INC0000000" }, "x"),
        );
        expect(error).toBeInstanceOf(HelpdeskError);
        expect((error as HelpdeskError).code).toBe("not_found");
      },
    },
    {
      name: "updateTicket in_progress, resolved, closed each resolve",
      run: async (c, created) => {
        const { ref } = await create(c, created);
        for (const state of ["in_progress", "resolved", "closed"] as const) {
          await expect(c.updateTicket(ref, { state })).resolves.not.toThrow();
        }
      },
    },
    {
      name: "a non-UUID ticket ID and an empty note throw TypeError",
      run: async (c, created) => {
        const { ref } = await create(c, created);
        expect(await rejection(c.findByExternalRef("not-a-uuid"))).toBeInstanceOf(TypeError);
        expect(await rejection(c.addNote(ref, ""))).toBeInstanceOf(TypeError);
      },
    },
    {
      name: "health reports ok",
      run: async (c) => {
        expect(await c.health()).toEqual({ status: "ok" });
      },
    },
    {
      name: "extra input keys never reach anything recorded or sent",
      run: async (c, created) => {
        const sent: string[] = [];
        const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
          sent.push(String(url), String(init?.body ?? ""));
          throw new Error("network is off in the contract suite");
        });
        try {
          // The marker keys are passed with a cast, as a buggy caller would.
          const body = input(isTest, { rawDescription: RAW_MARKER, requesterName: NAME_MARKER });
          const attempt: unknown = await c.createTicket(body).catch((error: unknown) => error);
          if (typeof attempt === "object" && attempt !== null && "externalId" in attempt) {
            created.push(attempt as HelpdeskTicketRef);
          }
          const observed = JSON.stringify([
            sent,
            (c as { calls?: unknown }).calls ?? null,
            attempt instanceof Error ? [attempt.message, { ...attempt }] : attempt,
          ]);
          expect(observed).not.toContain(RAW_MARKER);
          expect(observed).not.toContain(NAME_MARKER);
        } finally {
          spy.mockRestore();
        }
      },
    },
  ];
}

/** A Vitest suite any HelpdeskConnector must pass. */
export function runHelpdeskContract(
  name: string,
  makeConnector: () => HelpdeskConnector,
  options: HelpdeskContractOptions = {},
): void {
  describe(`helpdesk contract: ${name}`, () => {
    let connector: HelpdeskConnector | null = null;
    let created: HelpdeskTicketRef[] = [];
    afterEach(async () => {
      if (connector && options.cleanup) await options.cleanup(connector, created);
      connector = null;
      created = [];
    });
    for (const testCase of helpdeskContractCases(options.isTest ?? true)) {
      it(testCase.name, async () => {
        connector = makeConnector();
        await testCase.run(connector, created);
      });
    }
  });
}
