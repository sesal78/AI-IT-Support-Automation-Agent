import { randomUUID } from "node:crypto";
import type { SensitiveChecker, TopicScores } from "@ai-it-support/ai";
import { SENSITIVE_TOPICS } from "@ai-it-support/ai";
import type { NewRedaction, NewTriage, Ticket } from "@ai-it-support/db";
import { describe, expect, it, vi } from "vitest";
import {
  createIntakeDeps,
  intakeTicket,
  intakeTicketPayload,
  runIntakeTicket,
  type IntakeDeps,
} from "./intake-ticket.js";

const ticketId = randomUUID();
const now = "2026-09-30T10:00:00.000000+00:00";

function ticket(title: string, description: string): Ticket {
  return {
    id: ticketId,
    source: "web",
    raw_title: title,
    raw_description: description,
    requester_email: "demo.user@example.test",
    requester_name: "Demo User",
    department: "Finance",
    status: "new",
    servicenow_sys_id: null,
    servicenow_number: null,
    idempotency_key: "key-1",
    is_test: false,
    created_at: now,
  };
}

function scores(value: number, overrides: Partial<TopicScores> = {}): TopicScores {
  const all = Object.fromEntries(SENSITIVE_TOPICS.map((t) => [t, value])) as TopicScores;
  return { ...all, ...overrides };
}

interface Harness {
  deps: IntakeDeps;
  calls: string[];
  redactions: NewRedaction[];
  triages: NewTriage[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  check: ReturnType<typeof vi.fn>;
  logs: unknown[][];
}

function harness(found: Ticket | null, checkerImpl: SensitiveChecker["check"]): Harness {
  const calls: string[] = [];
  const redactions: NewRedaction[] = [];
  const triages: NewTriage[] = [];
  const events: Harness["events"] = [];
  const logs: unknown[][] = [];
  const check = vi.fn(checkerImpl);
  const log = (...args: unknown[]) => {
    logs.push(args);
  };
  const deps: IntakeDeps = {
    repos: {
      getTicket: vi.fn(async () => {
        calls.push("getTicket");
        return found;
      }),
      saveRedaction: vi.fn(async (input: NewRedaction) => {
        calls.push("saveRedaction");
        redactions.push(input);
        return { ...input, created_at: now };
      }),
      saveTriage: vi.fn(async (input: NewTriage) => {
        calls.push("saveTriage");
        triages.push(input);
        return { ...input, created_at: now };
      }),
      addEvent: vi.fn(async (id: string, type: string, payload: Record<string, unknown> = {}) => {
        calls.push(`event:${type}`);
        events.push({ type, payload });
        return { id: events.length, ticket_id: id, type, payload, at: now };
      }),
    },
    checker: { check },
    threshold: 0.5,
    logger: { info: log, warn: log, error: log },
  };
  return { deps, calls, redactions, triages, events, check, logs };
}

const lowScores = async () => ({ scores: scores(0.1), checker: "typesafe:jev-test" });

describe("intake-ticket task", () => {
  it("is registered with id intake-ticket", () => {
    expect(intakeTicket.id).toBe("intake-ticket");
  });

  it("redacts, saves the redaction, checks and saves a non-sensitive triage", async () => {
    const h = harness(ticket("Laptop", "call 0412 345 678 about my laptop"), lowScores);

    const result = await runIntakeTicket({ ticketId }, h.deps);

    expect(h.redactions).toEqual([
      {
        ticket_id: ticketId,
        redacted_title: "Laptop",
        redacted_description: "call [REDACTED_PHONE] about my laptop",
        redaction_log: [{ type: "PHONE", count: 1 }],
      },
    ]);
    expect(h.triages).toEqual([
      {
        ticket_id: ticketId,
        sensitive: false,
        sensitive_flags: [],
        checker: "keywords+typesafe:jev-test",
      },
    ]);
    expect(h.calls).toEqual([
      "getTicket",
      "saveRedaction",
      "event:redacted",
      "saveTriage",
      "event:sensitive_checked",
    ]);
    expect(h.events.map((e) => e.type)).toEqual(["redacted", "sensitive_checked"]);
    expect(result).toEqual({ ticketId, sensitive: false, flags: [] });
  });

  it("flags termination from the keyword layer even when TypeSafe returns 0.0", async () => {
    const h = harness(
      ticket("Files", "I am being terminated tomorrow, need my files"),
      async () => ({ scores: scores(0), checker: "typesafe:jev-test" }),
    );

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.triages[0]).toMatchObject({ sensitive: true, sensitive_flags: ["termination"] });
    expect(h.events[1]).toEqual({
      type: "sensitive_checked",
      payload: { sensitive: true, flags: ["termination"], checker: "keywords+typesafe:jev-test" },
    });
  });

  it("flags security_incident from a Noul of 0.8 with no keyword hit", async () => {
    const h = harness(ticket("Odd email", "an email asked me to confirm my login"), async () => ({
      scores: scores(0.1, { security_incident: 0.8 }),
      checker: "typesafe:jev-test",
    }));

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.triages[0]).toMatchObject({ sensitive: true, sensitive_flags: ["security_incident"] });
  });

  it("uses the configured threshold", async () => {
    const h = harness(ticket("Odd email", "an email asked me to confirm my login"), async () => ({
      scores: scores(0.1, { security_incident: 0.8 }),
      checker: "typesafe:jev-test",
    }));
    h.deps.threshold = 0.9;

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.triages[0]).toMatchObject({ sensitive: false, sensitive_flags: [] });
  });

  it("sends only redacted text to the checker", async () => {
    const rawEmail = "jo.bloggs@example.test";
    const rawPhone = "+61 412 345 678";
    const rawSsn = "123-45-6789";
    const h = harness(
      ticket(`Locked out ${rawEmail}`, `mail ${rawEmail}, call ${rawPhone}, ssn ${rawSsn}`),
      lowScores,
    );

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.check).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(h.check.mock.calls);
    for (const raw of [rawEmail, rawPhone, rawSsn, "412 345 678"]) {
      expect(sent).not.toContain(raw);
    }
    expect(h.check).toHaveBeenCalledWith({
      title: "Locked out [REDACTED_EMAIL]",
      description: "mail [REDACTED_EMAIL], call [REDACTED_PHONE], ssn [REDACTED_SSN]",
    });
    // Title and description counts are summed per type.
    expect(h.redactions[0]!.redaction_log).toEqual(
      expect.arrayContaining([
        { type: "EMAIL", count: 2 },
        { type: "PHONE", count: 1 },
        { type: "SSN", count: 1 },
      ]),
    );
    expect(h.redactions[0]!.redaction_log).toHaveLength(3);
  });

  it("never logs ticket text, raw or redacted", async () => {
    const description = "I clicked a phishing link, my email is jo@x.com";
    const h = harness(ticket("Phishing help", description), lowScores);

    await runIntakeTicket({ ticketId }, h.deps);

    expect(h.logs.length).toBeGreaterThan(0);
    const logged = JSON.stringify(h.logs);
    for (const text of ["Phishing help", "clicked", "jo@x.com", "[REDACTED_EMAIL]"]) {
      expect(logged).not.toContain(text);
    }
    expect(logged).toContain(ticketId);
  });

  it("does not put ticket text in event payloads", async () => {
    const h = harness(ticket("Printer", "call 0412 345 678 about the printer"), lowScores);

    await runIntakeTicket({ ticketId }, h.deps, 2);

    expect(h.events[0]).toEqual({
      type: "redacted",
      payload: { redactions: [{ type: "PHONE", count: 1 }], attempt: 2 },
    });
    expect(JSON.stringify(h.events)).not.toContain("printer");
  });

  it("throws when the checker throws, after the redaction but before any triage row", async () => {
    const h = harness(ticket("Laptop", "call 0412 345 678"), async () => {
      throw new Error("typesafe unavailable");
    });

    await expect(runIntakeTicket({ ticketId }, h.deps)).rejects.toThrow("typesafe unavailable");

    expect(h.triages).toEqual([]);
    expect(h.calls).toEqual(["getTicket", "saveRedaction", "event:redacted"]);
  });

  it("fails with an error naming an unknown ticket id and writes nothing", async () => {
    const h = harness(null, lowScores);

    await expect(runIntakeTicket({ ticketId }, h.deps)).rejects.toThrow(ticketId);

    expect(h.calls).toEqual(["getTicket"]);
    expect(h.check).not.toHaveBeenCalled();
  });
});

describe("intakeTicketPayload", () => {
  it("rejects {} with an error naming ticketId", () => {
    expect(() => intakeTicketPayload.parse({})).toThrow(/ticketId/);
  });

  it("rejects a ticketId that is not a uuid", () => {
    expect(intakeTicketPayload.safeParse({ ticketId: "123" }).success).toBe(false);
  });

  it("accepts a uuid ticketId", () => {
    expect(intakeTicketPayload.parse({ ticketId })).toEqual({ ticketId });
  });
});

describe("createIntakeDeps", () => {
  const env = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
    SUPABASE_DB_SCHEMA: "itsupport",
    TYPESAFE_API_KEY: "test-typesafe-key",
  };

  it("builds deps with the default threshold of 0.5", () => {
    const deps = createIntakeDeps(env);
    expect(deps.threshold).toBe(0.5);
    expect(typeof deps.repos.getTicket).toBe("function");
    expect(typeof deps.checker.check).toBe("function");
  });

  it("reads SENSITIVE_THRESHOLD", () => {
    expect(createIntakeDeps({ ...env, SENSITIVE_THRESHOLD: "0.7" }).threshold).toBe(0.7);
  });

  it("fails naming SENSITIVE_THRESHOLD when it is invalid", () => {
    expect(() => createIntakeDeps({ ...env, SENSITIVE_THRESHOLD: "2" })).toThrow(
      /SENSITIVE_THRESHOLD/,
    );
  });

  it("fails naming TYPESAFE_API_KEY when it is missing", () => {
    expect(() => createIntakeDeps({ ...env, TYPESAFE_API_KEY: undefined })).toThrow(
      /TYPESAFE_API_KEY/,
    );
  });

  it("fails naming SUPABASE_URL when it is missing", () => {
    expect(() => createIntakeDeps({ ...env, SUPABASE_URL: undefined })).toThrow(/SUPABASE_URL/);
  });
});
