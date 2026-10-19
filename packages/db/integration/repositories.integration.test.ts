import { randomUUID } from "node:crypto";
import { buildKbQuery, IllegalTransitionError } from "@ai-it-support/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "../src/client.js";
import { DbError } from "../src/errors.js";
import { createRepositories, type NewTicket, type Repositories } from "../src/repositories.js";
import { clientFor } from "./pg-container.js";
import { removeRestStack, startRestStack, type RestStack } from "./rest-stack.js";

let stack: RestStack | undefined;
let db: pg.Client | undefined;
let client: DbClient;
let repos: Repositories;

function sql(): pg.Client {
  if (!db) throw new Error("database client not connected");
  return db;
}

const ticket = (key: string): NewTicket => ({
  source: "web",
  raw_title: "VPN down",
  raw_description: "Cannot connect to VPN from home",
  requester_email: "demo.user@example.test",
  requester_name: "Demo User",
  department: "Finance",
  idempotency_key: key,
});

beforeAll(async () => {
  stack = await startRestStack();
  db = clientFor(stack.pg);
  await db.connect();
  // Same wiring as production: env in, supabase-js client out.
  client = createDbClient({
    SUPABASE_URL: stack.url,
    SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
    SUPABASE_DB_SCHEMA: "itsupport",
  });
  repos = createRepositories(client);
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await removeRestStack(stack);
});

describe("harness", () => {
  it("has the Supabase roles, with authenticator able to switch to each API role", async () => {
    const { rows } = await sql().query(
      `select r.rolname from pg_auth_members m
       join pg_roles r on r.oid = m.roleid
       join pg_roles u on u.oid = m.member
       where u.rolname = 'authenticator' order by r.rolname`,
    );
    expect(rows.map((row: { rolname: string }) => row.rolname)).toEqual([
      "anon",
      "authenticated",
      "service_role",
    ]);
  });

  it("rejects requests without the service_role JWT (anon has no access to itsupport)", async () => {
    const res = await fetch(`${stack?.url}/rest/v1/tickets?select=id`, {
      headers: { "accept-profile": "itsupport" },
    });
    expect(res.status).toBe(401);
  });
});

describe("repositories over supabase-js + PostgREST", () => {
  it("createTicket returns created: true and a uuid, then the same id with created: false", async () => {
    const key = `it-${randomUUID()}`;

    const first = await repos.createTicket(ticket(key));
    expect(first.created).toBe(true);
    expect(first.ticket.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.ticket.status).toBe("new");

    const second = await repos.createTicket({ ...ticket(key), raw_title: "Different title" });
    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(second.ticket.raw_title).toBe("VPN down");

    const { rows } = await sql().query(
      "select count(*)::int as n from itsupport.tickets where idempotency_key = $1",
      [key],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it("getTicket returns the row, and null for an unknown id", async () => {
    const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));
    expect(await repos.getTicket(created.id)).toEqual(created);
    expect(await repos.getTicket(randomUUID())).toBeNull();
  });

  it("addEvent is visible to a direct select; an update through the client fails", async () => {
    const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));

    const event = await repos.addEvent(created.id, "received", { via: "web" });

    const { rows } = await sql().query(
      "select id, type, payload from itsupport.ticket_events where ticket_id = $1",
      [created.id],
    );
    expect(rows).toEqual([{ id: String(event.id), type: "received", payload: { via: "web" } }]);

    const update = await client
      .from("ticket_events")
      .update({ type: "tampered" })
      .eq("id", event.id)
      .select();
    expect(update.error?.code).toBe("42501"); // permission denied: append-only

    const after = await sql().query("select type from itsupport.ticket_events where id = $1", [
      event.id,
    ]);
    expect(after.rows).toEqual([{ type: "received" }]);
  });

  it("addEvent for an unknown ticket throws DbError with the foreign-key code", async () => {
    await expect(repos.addEvent(randomUUID(), "received")).rejects.toMatchObject({
      name: "DbError",
      operation: "addEvent",
      code: "23503",
    });
  });

  it("saveTriage twice leaves exactly 1 row with the second values", async () => {
    const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));

    await repos.saveTriage({
      ticket_id: created.id,
      sensitive: false,
      sensitive_flags: [],
      checker: "keywords",
    });
    const saved = await repos.saveTriage({
      ticket_id: created.id,
      sensitive: true,
      sensitive_flags: ["termination"],
      checker: "keywords+typesafe",
    });
    expect(saved).toMatchObject({ sensitive: true, sensitive_flags: ["termination"] });

    const { rows } = await sql().query(
      "select sensitive, sensitive_flags, checker from itsupport.triage_results where ticket_id = $1",
      [created.id],
    );
    expect(rows).toEqual([
      { sensitive: true, sensitive_flags: ["termination"], checker: "keywords+typesafe" },
    ]);
  });

  it("saveRedaction twice leaves exactly 1 row with the second values", async () => {
    const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));
    const base = { ticket_id: created.id, redacted_title: "VPN down" };

    await repos.saveRedaction({ ...base, redacted_description: "first", redaction_log: [] });
    const saved = await repos.saveRedaction({
      ...base,
      redacted_description: "call [REDACTED_PHONE]",
      redaction_log: [{ type: "PHONE", count: 1 }],
    });
    expect(saved.redaction_log).toEqual([{ type: "PHONE", count: 1 }]);

    const { rows } = await sql().query(
      "select redacted_description, redaction_log from itsupport.ticket_redactions where ticket_id = $1",
      [created.id],
    );
    expect(rows).toEqual([
      {
        redacted_description: "call [REDACTED_PHONE]",
        redaction_log: [{ type: "PHONE", count: 1 }],
      },
    ]);
  });
});

describe("searchKb over supabase-js + PostgREST", () => {
  const SLUG = `it-kb-${randomUUID()}`;

  beforeAll(async () => {
    await sql().query(
      `insert into itsupport.kb_articles (slug, title, content, category, assignment_group)
       values ($1, 'VPN will not connect', 'Restart the VPN client and connect again from home.', 'network', 'Network')`,
      [SLUG],
    );
  });

  it("finds the article for the built query", async () => {
    const query = buildKbQuery("My VPN will not connect from home");
    expect(query).toBe("vpn or connect or home");
    const hits = await repos.searchKb(query, 5);
    expect(hits.map((hit) => hit.slug)).toContain(SLUG);
    expect(hits[0]?.rank).toBeGreaterThan(0);
  });

  it("finds an article that spells Wi-Fi with a hyphen from a Wi-Fi ticket", async () => {
    const slug = `${SLUG}-wifi`;
    await sql().query(
      `insert into itsupport.kb_articles (slug, title, content, category, assignment_group)
       values ($1, 'Wi-Fi keeps dropping', 'Forget the Wi-Fi network and join it again.', 'network', 'Network')`,
      [slug],
    );
    for (const text of ["Wi-Fi keeps dropping", "my wifi is slow"]) {
      const hits = await repos.searchKb(buildKbQuery(text), 20);
      expect(hits.map((hit) => hit.slug)).toContain(slug);
    }
  });

  it("returns [] for a blank query and clamps the limit", async () => {
    expect(await repos.searchKb("")).toEqual([]);
    expect(await repos.searchKb(buildKbQuery("the and of it is"))).toEqual([]);
    expect((await repos.searchKb("vpn", 0)).length).toBeLessThanOrEqual(1);
    expect((await repos.searchKb("vpn", 1000)).length).toBeLessThanOrEqual(20);
  });

  const inputs = [
    "",
    "the and of it is",
    "!!! ??? ...",
    "x".repeat(5000),
    Array.from({ length: 1000 }, (_, i) => `word${i}`)
      .join(" ")
      .slice(0, 5000),
    "call [REDACTED_PHONE] about the printer",
    `"vpn" -wifi (router) OR laptop AND mouse`,
    "vpn:* & wifi | !router <-> dock",
    "'; drop table itsupport.kb_articles; --",
    "foo[REDACTED_EMAIL]bar [redacted_x] [[[ ]]]",
    "Caf\u00e9 na\u00efve \u043f\u0440\u0438\u0432\u0435\u0442 \u4f60\u597d \u{1F600} vpn\tdown\nrouter",
  ];
  it.each(inputs)("runs the built query for %j without an error", async (text) => {
    const hits = await repos.searchKb(buildKbQuery(text));
    expect(Array.isArray(hits)).toBe(true);
  });

  it("the attack inputs left the table intact", async () => {
    const { rows } = await sql().query("select to_regclass('itsupport.kb_articles')::text as t");
    expect(rows[0]).toEqual({ t: "itsupport.kb_articles" });
  });
});

describe("reserveAiCall and completeAiCall over supabase-js + PostgREST", () => {
  const base = { kind: "it-meter", calls: 1, capCalls: 1_000_000, environment: "it" } as const;

  it("reserveAiCall writes a row with null tokens; completeAiCall sets them", async () => {
    const reservation = await repos.reserveAiCall({ ...base, provider: "llm" });
    expect(reservation.allowed).toBe(true);
    expect(reservation.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(reservation.usedCalls).toBeGreaterThanOrEqual(1);

    const before = await sql().query(
      "select provider, kind, calls, tokens_in, tokens_out, environment from itsupport.ai_calls where id = $1",
      [reservation.callId],
    );
    expect(before.rows).toEqual([
      {
        provider: "llm",
        kind: "it-meter",
        calls: 1,
        tokens_in: null,
        tokens_out: null,
        environment: "it",
      },
    ]);

    await repos.completeAiCall(reservation.callId as string, { tokensIn: 120, tokensOut: 30 });
    const after = await sql().query(
      "select tokens_in, tokens_out from itsupport.ai_calls where id = $1",
      [reservation.callId],
    );
    expect(after.rows).toEqual([{ tokens_in: 120, tokens_out: 30 }]);
  });

  it("reserves several calls at once and links a ticket", async () => {
    const { ticket: row } = await repos.createTicket(ticket(`it-${randomUUID()}`));
    const reservation = await repos.reserveAiCall({
      ...base,
      provider: "typesafe",
      calls: 7,
      ticketId: row.id,
    });
    const { rows } = await sql().query(
      "select calls, ticket_id from itsupport.ai_calls where id = $1",
      [reservation.callId],
    );
    expect(rows).toEqual([{ calls: 7, ticket_id: row.id }]);
  });

  it("refuses with no row when the cap is 0", async () => {
    const reservation = await repos.reserveAiCall({
      ...base,
      provider: "llm",
      kind: "it-refused",
      capCalls: 0,
    });
    expect(reservation).toMatchObject({ allowed: false, callId: null });
    const { rows } = await sql().query(
      "select count(*)::int as n from itsupport.ai_calls where kind = 'it-refused'",
    );
    expect(rows[0].n).toBe(0);
  });

  it("completeAiCall throws DbError for an unknown call id and for a malformed one", async () => {
    await expect(
      repos.completeAiCall(randomUUID(), { tokensIn: 1, tokensOut: 1 }),
    ).rejects.toBeInstanceOf(DbError);
    await expect(
      repos.completeAiCall("not-a-uuid", { tokensIn: 1, tokensOut: 1 }),
    ).rejects.toBeInstanceOf(DbError);
  });
});

describe("pipeline repositories over supabase-js + PostgREST", () => {
  const status = async (id: string): Promise<string> => {
    const { rows } = await sql().query("select status from itsupport.tickets where id = $1", [id]);
    return (rows[0] as { status: string }).status;
  };

  it("setTicketStatus moves new -> redacted once, then is a no-op", async () => {
    const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));
    expect(await repos.setTicketStatus(created.id, "redacted")).toEqual({ changed: true });
    expect(await repos.setTicketStatus(created.id, "redacted")).toEqual({ changed: false });
    expect(await status(created.id)).toBe("redacted");
  });

  it("setTicketStatus rejects new -> triaged and leaves the row unchanged", async () => {
    const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));
    await expect(repos.setTicketStatus(created.id, "triaged")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    expect(await status(created.id)).toBe("new");
  });

  it("setTicketStatus throws DbError for an unknown ticket", async () => {
    await expect(repos.setTicketStatus(randomUUID(), "redacted")).rejects.toBeInstanceOf(DbError);
  });

  it("two parallel redacted -> triaged calls end triaged with exactly one changed: true", async () => {
    for (let round = 0; round < 5; round++) {
      const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));
      await sql().query("update itsupport.tickets set status = 'redacted' where id = $1", [
        created.id,
      ]);
      const results = await Promise.all([
        repos.setTicketStatus(created.id, "triaged"),
        repos.setTicketStatus(created.id, "triaged"),
      ]);
      expect(results.filter((r) => r.changed)).toHaveLength(1);
      expect(await status(created.id)).toBe("triaged");
    }
  });

  it("saveTriageResult writes the 13 columns and keeps the sensitive-check columns", async () => {
    const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));
    await repos.saveTriage({
      ticket_id: created.id,
      sensitive: true,
      sensitive_flags: ["termination"],
      checker: "keywords",
    });
    const before = await repos.getTriage(created.id);
    expect(before).toMatchObject({ category: null, triaged_at: null, kb_article_ids: null });

    const kbId = randomUUID();
    const saved = await repos.saveTriageResult(created.id, {
      category: "network",
      subcategory: "vpn",
      priority: "P3",
      urgency: "medium",
      assignmentGroup: "Network",
      route: "review",
      probabilities: { network: 0.75 },
      flags: ["needs_info"],
      groundingScore: 0.5,
      kbArticleIds: [kbId],
      suggestedFix: { steps: ["restart"] },
      modelVersions: { llm: "m1" },
    });
    expect(saved.triaged_at).not.toBeNull();

    const { rows } = await sql().query(
      `select sensitive, sensitive_flags, checker, category, subcategory, priority, urgency,
              assignment_group, route, probabilities, flags, grounding_score::float8 as grounding_score,
              kb_article_ids, suggested_fix, model_versions, triaged_at is not null as triaged
       from itsupport.triage_results where ticket_id = $1`,
      [created.id],
    );
    expect(rows).toEqual([
      {
        sensitive: true,
        sensitive_flags: ["termination"],
        checker: "keywords",
        category: "network",
        subcategory: "vpn",
        priority: "P3",
        urgency: "medium",
        assignment_group: "Network",
        route: "review",
        probabilities: { network: 0.75 },
        flags: ["needs_info"],
        grounding_score: 0.5,
        kb_article_ids: [kbId],
        suggested_fix: { steps: ["restart"] },
        model_versions: { llm: "m1" },
        triaged: true,
      },
    ]);
    expect(await repos.getTriage(created.id)).toEqual(saved);
  });

  it("saveTriageResult throws DbError when the ticket has no triage row", async () => {
    const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));
    await expect(
      repos.saveTriageResult(created.id, {
        category: "inquiry",
        subcategory: null,
        priority: "P4",
        urgency: "low",
        assignmentGroup: "Service Desk",
        route: "auto",
        probabilities: {},
        flags: [],
        groundingScore: null,
        kbArticleIds: [],
        suggestedFix: null,
        modelVersions: {},
      }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it("getRedaction returns null without a redaction and the row with one", async () => {
    const { ticket: created } = await repos.createTicket(ticket(`it-${randomUUID()}`));
    expect(await repos.getRedaction(created.id)).toBeNull();
    const saved = await repos.saveRedaction({
      ticket_id: created.id,
      redacted_title: "VPN down",
      redacted_description: "no access",
      redaction_log: [],
    });
    expect(await repos.getRedaction(created.id)).toEqual(saved);
    expect(await repos.getTriage(created.id)).toBeNull();
  });
});
