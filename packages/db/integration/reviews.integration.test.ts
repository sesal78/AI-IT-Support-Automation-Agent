import { randomUUID } from "node:crypto";
import { internalTicketViewSchema } from "@ai-it-support/shared";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../src/client.js";
import { DbError } from "../src/errors.js";
import { createRepositories, type Repositories } from "../src/repositories.js";
import { clientFor } from "./pg-container.js";
import { removeRestStack, startRestStack, type RestStack } from "./rest-stack.js";

// Review repositories over the real local stack: supabase-js -> PostgREST -> Postgres
// with migrations 0001 to 0005. Fake IDs only.
const USER_A = "U0000000001";
const USER_B = "U0000000002";
const TOKEN_MARKER = "integration-wait-token-marker";

let stack: RestStack | undefined;
let db: pg.Client | undefined;
let repos: Repositories;

function sql(): pg.Client {
  if (!db) throw new Error("database client not connected");
  return db;
}

async function newTicket(): Promise<string> {
  const { ticket } = await repos.createTicket({
    source: "web",
    raw_title: "VPN down",
    raw_description: "Cannot connect to VPN from home",
    requester_email: "demo.user@example.test",
    idempotency_key: `rev-${randomUUID()}`,
  });
  return ticket.id;
}

async function newReview(waitTokenId = TOKEN_MARKER) {
  const ticketId = await newTicket();
  return repos.createTriageReview({ ticketId, waitTokenId });
}

beforeAll(async () => {
  stack = await startRestStack();
  db = clientFor(stack.pg);
  await db.connect();
  repos = createRepositories(
    createDbClient({
      SUPABASE_URL: stack.url,
      SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
      SUPABASE_DB_SCHEMA: "itsupport",
    }),
  );
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await removeRestStack(stack);
});

describe("createTriageReview", () => {
  it("inserts an open triage review", async () => {
    const review = await newReview();
    expect(review).toMatchObject({
      kind: "triage",
      proposal_id: null,
      slack_user_id: null,
      decision: null,
      decided_at: null,
      slack_ts: null,
      wait_token_id: TOKEN_MARKER,
    });
    expect(await repos.getReview(review.id)).toEqual(review);
    expect(await repos.getTriageReview(review.ticket_id)).toEqual(review);
  });

  it("returns the same row twice and does not store the second wait token", async () => {
    const ticketId = await newTicket();
    const first = await repos.createTriageReview({ ticketId, waitTokenId: "first-token" });
    const second = await repos.createTriageReview({ ticketId, waitTokenId: "second-token" });
    expect(second).toEqual(first);
    expect(second.wait_token_id).toBe("first-token");
    const { rows } = await sql().query(
      "select wait_token_id from itsupport.reviews where ticket_id = $1",
      [ticketId],
    );
    expect(rows).toEqual([{ wait_token_id: "first-token" }]);
  });

  it("returns the already decided row unchanged", async () => {
    const review = await newReview();
    await repos.decideReview(review.id, "approve", USER_A);
    const again = await repos.createTriageReview({
      ticketId: review.ticket_id,
      waitTokenId: "late-token",
    });
    expect(again.decision).toBe("approve");
    expect(again.wait_token_id).toBe(TOKEN_MARKER);
  });

  it("throws DbError, not an existing row, for a ticket that does not exist (23503)", async () => {
    const error = await repos
      .createTriageReview({ ticketId: randomUUID(), waitTokenId: "t" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).operation).toBe("createTriageReview");
    expect((error as DbError).code).toBe("23503");
  });
});

describe("getReview and getTriageReview", () => {
  it("return null for an unknown id and a ticket without a review", async () => {
    expect(await repos.getReview(randomUUID())).toBeNull();
    expect(await repos.getTriageReview(await newTicket())).toBeNull();
  });
});

describe("setReviewSlackTs", () => {
  it("changes once; a second ts is refused and the stored ts stays", async () => {
    const review = await newReview();
    expect(await repos.setReviewSlackTs(review.id, "1730000000.000100")).toEqual({
      changed: true,
    });
    expect(await repos.setReviewSlackTs(review.id, "1730000000.000200")).toEqual({
      changed: false,
    });
    expect((await repos.getReview(review.id))?.slack_ts).toBe("1730000000.000100");
  });

  it("reports changed false for an unknown id", async () => {
    expect(await repos.setReviewSlackTs(randomUUID(), "1.1")).toEqual({ changed: false });
  });
});

describe("decideReview", () => {
  it("approves once and keeps the first decision against a later reject", async () => {
    const review = await newReview();
    const first = await repos.decideReview(review.id, "approve", USER_A);
    expect(first.changed).toBe(true);
    expect(first.review).toMatchObject({ decision: "approve", slack_user_id: USER_A });
    expect(first.review.decided_at).not.toBeNull();

    const second = await repos.decideReview(review.id, "reject", USER_B);
    expect(second.changed).toBe(false);
    expect(second.review).toEqual(first.review);

    const stored = await repos.getReview(review.id);
    expect(stored).toMatchObject({ decision: "approve", slack_user_id: USER_A });
    expect(stored?.decided_at).toBe(first.review.decided_at);
  });

  it("records a timeout without a user, then refuses a late approve", async () => {
    const review = await newReview();
    const timedOut = await repos.decideReview(review.id, "timeout", null);
    expect(timedOut.changed).toBe(true);
    expect(timedOut.review).toMatchObject({ decision: "timeout", slack_user_id: null });
    const late = await repos.decideReview(review.id, "approve", USER_A);
    expect(late.changed).toBe(false);
    expect(late.review.decision).toBe("timeout");
  });

  it("gives exactly one winner among 10 parallel decisions, and all see the same decision", async () => {
    const review = await newReview();
    const calls = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? repos.decideReview(review.id, "approve", USER_A)
        : repos.decideReview(review.id, "reject", USER_B),
    );
    const outcomes = await Promise.all(calls);
    expect(outcomes.filter((outcome) => outcome.changed)).toHaveLength(1);
    const winner = outcomes.find((outcome) => outcome.changed);
    for (const outcome of outcomes) {
      expect(outcome.review.decision).toBe(winner?.review.decision);
      expect(outcome.review.slack_user_id).toBe(winner?.review.slack_user_id);
      expect(outcome.review.decided_at).toBe(winner?.review.decided_at);
    }
    const stored = await repos.getReview(review.id);
    expect(stored?.decision).toBe(winner?.review.decision);
  });

  it("holds the single-winner rule over repeated parallel rounds", async () => {
    for (let round = 0; round < 5; round++) {
      const review = await newReview();
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repos.decideReview(review.id, i < 5 ? "approve" : "reject", i < 5 ? USER_A : USER_B),
        ),
      );
      expect(outcomes.filter((outcome) => outcome.changed)).toHaveLength(1);
      expect(new Set(outcomes.map((outcome) => outcome.review.decision)).size).toBe(1);
    }
  });

  it("throws DbError for an unknown review id", async () => {
    const error = await repos
      .decideReview(randomUUID(), "approve", USER_A)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).operation).toBe("decideReview");
  });
});

describe("getKbArticlesByIds", () => {
  it("returns id, slug and title in input order and leaves unknown ids out", async () => {
    const { rows } = await sql().query(
      `insert into itsupport.kb_articles (slug, title, content, category, assignment_group)
       values ($1, 'Title A', 'content a', 'network', 'Network'),
              ($2, 'Title B', 'content b', 'network', 'Network')
       returning id, slug, title`,
      [`rev-a-${randomUUID()}`, `rev-b-${randomUUID()}`],
    );
    const [a, b] = rows as { id: string; slug: string; title: string }[];
    if (!a || !b) throw new Error("seed failed");
    expect(await repos.getKbArticlesByIds([b.id, a.id, randomUUID()])).toEqual([b, a]);
    expect(await repos.getKbArticlesByIds([a.id, b.id, a.id])).toEqual([a, b]);
    expect(await repos.getKbArticlesByIds([])).toEqual([]);
    expect(await repos.getKbArticlesByIds([randomUUID()])).toEqual([]);
  });
});

describe("getTicketView and probeSchema with reviews", () => {
  it("lists reviews oldest first, parses with the strict schema, and never leaks the wait token", async () => {
    const review = await newReview("view-wait-token-marker");
    await repos.setReviewSlackTs(review.id, "1730000000.000100");
    await repos.decideReview(review.id, "approve", USER_A);
    const view = await repos.getTicketView(review.ticket_id);
    expect(view?.reviews).toEqual([
      {
        id: review.id,
        kind: "triage",
        decision: "approve",
        decidedBy: USER_A,
        decidedAt: expect.any(String),
        slackTs: "1730000000.000100",
        createdAt: expect.any(String),
      },
    ]);
    expect(internalTicketViewSchema.safeParse(view).success).toBe(true);
    expect(JSON.stringify(view)).not.toContain("view-wait-token-marker");
  });

  it("orders a ticket's reviews by created_at, oldest first, whatever the insert order", async () => {
    const ticketId = await newTicket();
    const insert = async (kind: "triage" | "autofix", createdAt: string) => {
      const { rows } = await sql().query<{ id: string }>(
        `insert into itsupport.reviews (ticket_id, kind, proposal_id, wait_token_id, created_at)
         values ($1, $2, $3, $4, $5) returning id`,
        [ticketId, kind, kind === "autofix" ? randomUUID() : null, `order-${randomUUID()}`, createdAt],
      );
      const [row] = rows;
      if (!row) throw new Error("seed failed");
      return row.id;
    };
    // Inserted newest, oldest, middle, so insert order differs from time order.
    const newest = await insert("autofix", "2026-03-03T00:00:00Z");
    const oldest = await insert("triage", "2026-01-01T00:00:00Z");
    const middle = await insert("autofix", "2026-02-02T00:00:00Z");
    const view = await repos.getTicketView(ticketId);
    expect(view?.reviews.map((r) => r.id)).toEqual([oldest, middle, newest]);
  });

  it("gives reviews: [] for a ticket without a review", async () => {
    const view = await repos.getTicketView(await newTicket());
    expect(view?.reviews).toEqual([]);
  });

  it("probeSchema reports migration0005 true on the full stack", async () => {
    expect(await repos.probeSchema()).toEqual({
      database: true,
      migration0003: true,
      migration0005: true,
    });
  });
});
