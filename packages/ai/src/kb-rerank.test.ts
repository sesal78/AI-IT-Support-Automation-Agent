import { AuthenticationError, TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { TriageParseError } from "./judgments.js";
import { KB_RERANK_CONTENT_MAX_CHARS, createKbReranker, type KbCandidate } from "./kb-rerank.js";
import { BudgetExceededError, createMeter, type MeterRepos } from "./meter.js";
import { createAiRuntime, type TraceSpan } from "./trace.js";
import { TYPESAFE_MODEL } from "./typesafe-model.js";

const TICKET = "00000000-0000-4000-8000-000000000001";
const FAKE_KEY = "k".repeat(16);
const TITLE_MARKER = "q".repeat(12);
const DESCRIPTION_MARKER = "x".repeat(12);

function candidate(n: number, rank: number): KbCandidate {
  return {
    id: `00000000-0000-4000-8000-00000000000${n}`,
    slug: `article-${n}`,
    title: `Title ${"t".repeat(n)}`,
    content: `Content ${"c".repeat(n)}`,
    rank,
  };
}

function scoreAnswer(value: unknown) {
  return {
    type: "score",
    score: value,
    confidence: 0.5,
    legend: { 0: "a", 1: "b", 2: "c", 3: "d" },
    probabilities: { 0: 0.25, 1: 0.25, 2: 0.25, 3: 0.25 },
  };
}

function response(scores: unknown[]) {
  return {
    model: "jev-1.13.0",
    answers: Object.fromEntries(scores.map((s, i) => [`a${i + 1}`, scoreAnswer(s)])),
    usage: { input_tokens: 400, output_tokens: 9 },
  };
}

interface Captured {
  body: {
    model: string;
    state: unknown;
    questions: Record<string, { type: string; instructions: unknown; criteria: unknown }>;
  };
}

function setup(options: { body?: unknown; status?: number; allowed?: boolean } = {}) {
  const captured: Captured[] = [];
  const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
    captured.push({ body: JSON.parse(String(init?.body)) });
    const status = options.status ?? 200;
    const body = status === 200 ? options.body : { detail: "error" };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  const client = new TypeSafeClient({
    apiKey: FAKE_KEY,
    baseURL: "https://typesafe.test",
    logLevel: "off",
    fetch,
    retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 },
  });
  const repos = {
    reserveAiCall: vi.fn(async () => ({
      allowed: options.allowed ?? true,
      usedCalls: 5,
      callId: options.allowed === false ? null : "00000000-0000-4000-8000-0000000000aa",
    })),
    completeAiCall: vi.fn(async () => undefined),
  } satisfies MeterRepos;
  const meter = createMeter({
    repos,
    caps: { llm: 100, typesafe: 1000 },
    environment: "e2e",
    alert: vi.fn(),
    logger: { error: vi.fn() },
  });
  const spans: TraceSpan[] = [];
  const runtime = createAiRuntime({
    meter,
    sink: { record: vi.fn(async (span: TraceSpan) => void spans.push(span)) },
    addEvent: vi.fn(async () => undefined),
    environment: "e2e",
    logger: { error: vi.fn() },
  });
  const reranker = createKbReranker({ client, runtime });
  return { reranker, captured, repos, spans, fetch };
}

const ticket = { title: `VPN ${TITLE_MARKER}`, description: `It drops ${DESCRIPTION_MARKER}` };
// Ranks descend, so a1..a5 follow this order.
const FIVE = [
  candidate(1, 0.9),
  candidate(2, 0.8),
  candidate(3, 0.7),
  candidate(4, 0.6),
  candidate(5, 0.5),
];

describe("createKbReranker", () => {
  it("returns the top 3 by normalised score, best first", async () => {
    const { reranker } = setup({ body: response([0.3, 2.7, 1.5, 2.9, 0.0]) });
    const result = await reranker.rerankKb({ ticketId: TICKET, ticket, candidates: FIVE });
    expect(result).toEqual([
      { id: FIVE[3]!.id, slug: "article-4", score: 0.967 },
      { id: FIVE[1]!.id, slug: "article-2", score: 0.9 },
      { id: FIVE[2]!.id, slug: "article-3", score: 0.5 },
    ]);
  });

  it("returns 2 entries for 2 candidates", async () => {
    const { reranker } = setup({ body: response([1, 2]) });
    const result = await reranker.rerankKb({
      ticketId: TICKET,
      ticket,
      candidates: FIVE.slice(0, 2),
    });
    expect(result.map((r) => r.slug)).toEqual(["article-2", "article-1"]);
  });

  it("returns [] with no request and no budget reserved for 0 candidates", async () => {
    const { reranker, fetch, repos } = setup();
    expect(await reranker.rerankKb({ ticketId: TICKET, ticket, candidates: [] })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(repos.reserveAiCall).not.toHaveBeenCalled();
  });

  it("breaks a score tie by the higher full-text rank", async () => {
    // Passed low rank first: the reranker orders by rank, so a1 is the 0.9 one.
    const low = candidate(1, 0.2);
    const high = candidate(2, 0.9);
    const { reranker, captured } = setup({ body: response([2, 2]) });
    const result = await reranker.rerankKb({ ticketId: TICKET, ticket, candidates: [low, high] });
    expect(result.map((r) => r.slug)).toEqual(["article-2", "article-1"]);
    expect(captured[0]!.body.state).toMatchObject({ articles: { a1: { title: high.title } } });
  });

  it("scores only the 5 highest-ranked of more than 5 candidates", async () => {
    const extra = candidate(6, 0.1);
    const { reranker, captured, repos } = setup({ body: response([0, 0, 0, 0, 3]) });
    const result = await reranker.rerankKb({
      ticketId: TICKET,
      ticket,
      candidates: [extra, ...FIVE],
    });
    expect(Object.keys(captured[0]!.body.questions)).toHaveLength(5);
    expect(JSON.stringify(captured[0]!.body.state)).not.toContain(extra.title);
    expect(result[0]!.slug).toBe("article-5");
    expect(repos.reserveAiCall).toHaveBeenCalledWith(expect.objectContaining({ calls: 5 }));
  });

  it("sends one request with one 4-level Score question per candidate and minimal state", async () => {
    const { reranker, captured } = setup({ body: response([0.3, 2.7, 1.5, 2.9, 0.0]) });
    await reranker.rerankKb({ ticketId: TICKET, ticket, candidates: FIVE });

    expect(captured).toHaveLength(1);
    const { body } = captured[0]!;
    expect(body.model).toBe(TYPESAFE_MODEL);
    expect(Object.keys(body.questions)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    for (const [key, q] of Object.entries(body.questions)) {
      expect(q.type).toBe("score");
      expect(q.criteria).toHaveLength(4);
      expect(q.instructions).toContain(`\`articles.${key}\``);
      expect(q.instructions).toContain("`ticket`");
    }
    expect(body.state).toEqual({
      ticket: { title: ticket.title, description: ticket.description },
      articles: Object.fromEntries(
        FIVE.map((c, i) => [`a${i + 1}`, { title: c.title, content: c.content }]),
      ),
    });
    const questions = JSON.stringify(body.questions);
    for (const marker of [TITLE_MARKER, DESCRIPTION_MARKER]) {
      expect(questions).not.toContain(marker);
    }
  });

  it("caps the article content sent", async () => {
    const long = { ...candidate(1, 0.5), content: "z".repeat(KB_RERANK_CONTENT_MAX_CHARS + 50) };
    const { reranker, captured } = setup({ body: response([1]) });
    await reranker.rerankKb({ ticketId: TICKET, ticket, candidates: [long] });
    const state = captured[0]!.body.state as { articles: { a1: { content: string } } };
    expect(state.articles.a1.content).toHaveLength(KB_RERANK_CONTENT_MAX_CHARS);
  });

  it("meters typesafe calls of kind kb_rerank, one per candidate", async () => {
    const { reranker, repos, spans } = setup({ body: response([1, 2, 3]) });
    await reranker.rerankKb({ ticketId: TICKET, ticket, candidates: FIVE.slice(0, 3) });
    expect(repos.reserveAiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "typesafe",
        kind: "kb_rerank",
        calls: 3,
        ticketId: TICKET,
      }),
    );
    expect(repos.completeAiCall).toHaveBeenCalledWith(expect.any(String), {
      tokensIn: 400,
      tokensOut: 9,
    });
    expect(spans[0]).toMatchObject({ provider: "typesafe", kind: "kb_rerank" });
  });

  const bad: Array<[string, unknown]> = [
    ["a missing answer", { ...response([1, 2]), answers: { a1: scoreAnswer(1) } }],
    ["a score above 3", response([1, 3.5])],
    ["a negative score", response([-0.1, 1])],
    ["a string score", response([1, "2"])],
    [
      "a wrong answer type",
      { ...response([1, 2]), answers: { a1: scoreAnswer(1), a2: { type: "noul", noul: 0.5 } } },
    ],
  ];

  it.each(bad)("throws TriageParseError for %s", async (_name, body) => {
    const { reranker } = setup({ body });
    await expect(
      reranker.rerankKb({ ticketId: TICKET, ticket, candidates: FIVE.slice(0, 2) }),
    ).rejects.toBeInstanceOf(TriageParseError);
  });

  it("rethrows an API error", async () => {
    const { reranker } = setup({ status: 401 });
    await expect(
      reranker.rerankKb({ ticketId: TICKET, ticket, candidates: FIVE.slice(0, 2) }),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rethrows BudgetExceededError and sends no request", async () => {
    const { reranker, fetch } = setup({ allowed: false });
    await expect(
      reranker.rerankKb({ ticketId: TICKET, ticket, candidates: FIVE.slice(0, 2) }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
