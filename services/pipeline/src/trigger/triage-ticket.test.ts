import { randomUUID } from "node:crypto";
import type {
  FixDraft,
  GroundingResult,
  KbCandidate,
  KbRerankInput,
  KbRerankResult,
  TriageJudgments,
} from "@ai-it-support/ai";
import type { KbSearchResult, Redaction, Ticket, Triage } from "@ai-it-support/db";
import {
  ASSIGNMENT_GROUPS,
  CATEGORIES,
  PRIORITIES,
  URGENCIES,
  triageResultSchema,
  type TriageResult,
} from "@ai-it-support/shared";
import { createTriageJudge, type TriageJudgeDeps } from "@ai-it-support/ai";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createTriageDeps,
  runTriageTicket,
  triageTicket,
  triageTicketPayload,
  type TriageDeps,
} from "./triage-ticket.js";

const ticketId = randomUUID();
const now = "2026-10-10T10:00:00.000000+00:00";

// Unique markers in every raw field; none of them is in the redacted copy.
const MARKERS = {
  title: "RAWTITLEMARKER7731",
  description: "RAWDESCMARKER5519",
  name: "RAWNAMEMARKER4402",
  email: "rawemailmarker9087@example.test",
};
const REDACTED = {
  title: "VPN drops every hour",
  description: "The VPN client disconnects, call [REDACTED_PHONE]",
};

function ticket(status = "redacted"): Ticket {
  return {
    id: ticketId,
    source: "web",
    raw_title: `${MARKERS.title} VPN drops`,
    raw_description: `${MARKERS.description} call 0412 345 678`,
    requester_email: MARKERS.email,
    requester_name: MARKERS.name,
    department: "Finance",
    status,
    servicenow_sys_id: null,
    servicenow_number: null,
    idempotency_key: "key-1",
    is_test: false,
    created_at: now,
  };
}

const redaction: Redaction = {
  ticket_id: ticketId,
  redacted_title: REDACTED.title,
  redacted_description: REDACTED.description,
  redaction_log: [{ type: "PHONE", count: 1 }],
  created_at: now,
};

function triageRow(sensitive: boolean): Triage {
  return {
    ticket_id: ticketId,
    sensitive,
    sensitive_flags: sensitive ? ["termination"] : [],
    checker: "keywords+typesafe:jev-test",
    created_at: now,
    category: null,
    subcategory: null,
    priority: null,
    urgency: null,
    assignment_group: null,
    route: null,
    probabilities: null,
    flags: null,
    grounding_score: null,
    kb_article_ids: null,
    suggested_fix: null,
    model_versions: null,
    triaged_at: null,
  };
}

const choice = <L extends string>(labels: readonly L[], value: L, probability: number) => ({
  value,
  probability,
  confidence: probability,
  probabilities: Object.fromEntries(
    labels.map((label) => [label, label === value ? probability : 0]),
  ) as Record<L, number>,
});

const judgments: TriageJudgments = {
  category: choice(CATEGORIES, "network", 0.92),
  priority: choice(PRIORITIES, "P3", 0.81),
  urgency: choice(URGENCIES, "medium", 0.77),
  assignmentGroup: choice(ASSIGNMENT_GROUPS, "Network", 0.9),
  outageOrDuplicate: 0.05,
  injection: 0.01,
  needsInfo: 0.1,
  model: "jev-reported-1",
  tokensIn: 100,
  tokensOut: 10,
};

function candidate(n: number): KbSearchResult {
  return {
    id: randomUUID(),
    slug: `kb-${n}`,
    title: `Article ${n}`,
    content: `Content of article ${n}`,
    category: "network",
    assignment_group: "Network",
    rank: 1 - n / 10,
  };
}

const draft: FixDraft = {
  steps: ["Restart the VPN client", "Reinstall the VPN profile"],
  caveats: ["Needs admin rights"],
  model: "llm-reported-1",
  usage: { tokensIn: 50, tokensOut: 20 },
};

interface Options {
  found?: Ticket | null;
  redaction?: Redaction | null;
  triage?: Triage | null;
  candidates?: KbSearchResult[];
  ranked?: (candidates: readonly KbCandidate[]) => KbRerankResult[];
  grounding?: GroundingResult;
  /** A step name, `event:<type>` or `status:triaged`. */
  fail?: string;
  /** Fail only the first time, so a second attempt can succeed. */
  failOnce?: boolean;
}

const AI_STEPS = ["judge", "searchKb", "rerank", "draft", "grounding"];

function harness(options: Options = {}) {
  const calls: string[] = [];
  const aiInputs: unknown[] = [];
  const logs: unknown[][] = [];
  const saved: TriageResult[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const statuses: string[] = [];
  const candidates = options.candidates ?? [candidate(1), candidate(2), candidate(3)];
  // Stateful fakes: a failed write stores nothing, a successful one is seen by the next attempt.
  let failing = options.fail;
  let status = "redacted";
  let triageState = options.triage === undefined ? triageRow(false) : options.triage;
  const step = (name: string, input?: unknown) => {
    calls.push(name);
    if (input !== undefined) aiInputs.push(input);
    if (failing === name) {
      if (options.failOnce) failing = undefined;
      throw new Error(`${name} failed`);
    }
  };
  const log = (...args: unknown[]) => {
    logs.push(args);
  };
  const deps: TriageDeps = {
    repos: {
      getTicket: vi.fn(async () => {
        calls.push("getTicket");
        return options.found === undefined ? ticket(status) : options.found;
      }),
      getRedaction: vi.fn(async () => {
        calls.push("getRedaction");
        return options.redaction === undefined ? redaction : options.redaction;
      }),
      getTriage: vi.fn(async () => {
        calls.push("getTriage");
        return triageState;
      }),
      searchKb: vi.fn(async (query: string) => {
        step("searchKb", query);
        return candidates;
      }),
      saveTriageResult: vi.fn(async (id: string, result: TriageResult) => {
        step("saveTriageResult");
        // The real repository validates the same way before any database call.
        const r = triageResultSchema.parse(result);
        saved.push(r);
        triageState = {
          ...(triageState ?? triageRow(false)),
          ticket_id: id,
          category: r.category,
          subcategory: r.subcategory,
          priority: r.priority,
          urgency: r.urgency,
          assignment_group: r.assignmentGroup,
          route: r.route,
          probabilities: r.probabilities,
          flags: r.flags,
          grounding_score: r.groundingScore,
          kb_article_ids: r.kbArticleIds,
          suggested_fix: r.suggestedFix,
          model_versions: r.modelVersions,
          triaged_at: now,
        };
        return triageState;
      }),
      listEventTypes: vi.fn(async (_id: string, types: readonly string[]) => {
        calls.push("listEventTypes");
        return [...new Set(events.map((e) => e.type))].filter((t) => types.includes(t));
      }),
      addEvent: vi.fn(async (id: string, type: string, payload: Record<string, unknown> = {}) => {
        step(`event:${type}`);
        events.push({ type, payload });
        return { id: events.length, ticket_id: id, type, payload, at: now };
      }),
      setTicketStatus: vi.fn(async (_id: string, to: string) => {
        step(`status:${to}`);
        statuses.push(to);
        status = to;
        return { changed: true };
      }),
    },
    judge: {
      judge: vi.fn(async (input) => {
        step("judge", input);
        return judgments;
      }),
    },
    reranker: {
      rerankKb: vi.fn(async (input: KbRerankInput) => {
        step("rerank", input);
        return options.ranked
          ? options.ranked(input.candidates)
          : input.candidates
              .slice(0, 3)
              .map((c, i) => ({ id: c.id, slug: c.slug, score: 1 - i / 10 }));
      }),
    },
    drafter: {
      draft: vi.fn(async (input) => {
        step("draft", input);
        return draft;
      }),
    },
    grounding: {
      scoreGrounding: vi.fn(async (input) => {
        step("grounding", input);
        return options.grounding ?? { score: 0.9, flagged: false };
      }),
    },
    thresholds: {
      TRIAGE_CONFIDENCE_MIN: 0.7,
      INJECTION_THRESHOLD: 0.5,
      NEEDS_INFO_THRESHOLD: 0.5,
      OUTAGE_THRESHOLD: 0.5,
    },
    logger: { info: log, warn: log, error: log },
  };
  const aiCalls = () => calls.filter((c) => AI_STEPS.includes(c)).length;
  const writes = () =>
    calls.filter(
      (c) => c.startsWith("event:") || c.startsWith("status:") || c === "saveTriageResult",
    );
  return { deps, calls, aiInputs, logs, saved, events, statuses, candidates, writes, aiCalls };
}

describe("triage-ticket task", () => {
  it("is registered with id triage-ticket", () => {
    expect(triageTicket.id).toBe("triage-ticket");
  });

  it("runs every AI step before the writes, in pipeline order", async () => {
    const h = harness();

    await runTriageTicket({ ticketId }, h.deps);

    expect(h.calls).toEqual([
      "getTicket",
      "getRedaction",
      "getTriage",
      "judge",
      "searchKb",
      "rerank",
      "draft",
      "grounding",
      "saveTriageResult",
      "listEventTypes",
      "event:kb_matched",
      "event:fix_drafted",
      "event:policy_decided",
      "event:triaged",
      "status:triaged",
    ]);
  });

  it("saves the full triage result with model versions for typesafe and llm", async () => {
    const h = harness();

    await runTriageTicket({ ticketId }, h.deps);

    const ids = h.candidates.map((c) => c.id.toLowerCase());
    expect(h.saved).toEqual([
      {
        category: "network",
        subcategory: null,
        priority: "P3",
        urgency: "medium",
        assignmentGroup: "Network",
        route: "auto",
        probabilities: {
          category: 0.92,
          priority: 0.81,
          urgency: 0.77,
          assignment_group: 0.9,
          injection: 0.01,
          needs_info: 0.1,
          outage_or_duplicate: 0.05,
        },
        flags: [],
        groundingScore: 0.9,
        kbArticleIds: ids,
        suggestedFix: { steps: draft.steps, caveats: draft.caveats },
        modelVersions: { typesafe: "jev-reported-1", llm: "llm-reported-1" },
      },
    ]);
    expect(h.deps.repos.saveTriageResult).toHaveBeenCalledWith(ticketId, expect.anything());
  });

  it("saves at most 3 KB article IDs even when the reranker returns more", async () => {
    const candidates = [1, 2, 3, 4, 5].map(candidate);
    const h = harness({
      candidates,
      ranked: (all) => all.map((c) => ({ id: c.id, slug: c.slug, score: 0.5 })),
    });

    await runTriageTicket({ ticketId }, h.deps);

    expect(h.saved[0]!.kbArticleIds).toHaveLength(3);
    expect(h.events[0]).toEqual({
      type: "kb_matched",
      payload: { articleIds: candidates.slice(0, 3).map((c) => c.id), count: 3 },
    });
    const draftInput = vi.mocked(h.deps.drafter.draft).mock.calls[0]![0];
    expect(draftInput.articles).toHaveLength(3);
  });

  it("sends only text from ticket_redactions to every AI step", async () => {
    const h = harness();

    await runTriageTicket({ ticketId }, h.deps);

    expect(h.aiInputs).toHaveLength(5);
    const sent = JSON.stringify(h.aiInputs);
    for (const marker of Object.values(MARKERS)) expect(sent).not.toContain(marker);
    expect(sent).not.toContain("0412 345 678");
    expect(vi.mocked(h.deps.judge.judge).mock.calls[0]![0]).toMatchObject({
      ticketId,
      title: REDACTED.title,
      description: REDACTED.description,
    });
    expect(vi.mocked(h.deps.drafter.draft).mock.calls[0]![0].ticket).toEqual(REDACTED);
  });

  it("routes a clean ticket auto", async () => {
    const h = harness();

    await expect(runTriageTicket({ ticketId }, h.deps)).resolves.toEqual({
      ticketId,
      skipped: false,
      route: "auto",
      reasons: [],
    });
  });

  it("routes a sensitive ticket to review with the first reason sensitive, even when all else is clean", async () => {
    const h = harness({ triage: triageRow(true) });

    const result = await runTriageTicket({ ticketId }, h.deps);

    expect(result).toMatchObject({ route: "review", reasons: ["sensitive"] });
    expect(h.saved[0]!.route).toBe("review");
    // KB search, fix steps and grounding still run for the phase-4 reviewer card.
    expect(h.calls).toEqual(expect.arrayContaining(["rerank", "draft", "grounding"]));
  });

  it("keeps sensitive as the first reason when other rules fire too", async () => {
    const h = harness({ triage: triageRow(true), grounding: { score: 0.2, flagged: true } });

    const result = await runTriageTicket({ ticketId }, h.deps);

    expect(result).toMatchObject({ route: "review", reasons: ["sensitive", "ungrounded_fix"] });
  });

  it.each(["triaged", "review_pending", "auto"])(
    "skips a ticket with status %s: no AI call, no event, no write",
    async (status) => {
      const h = harness({ found: ticket(status) });

      await expect(runTriageTicket({ ticketId }, h.deps)).resolves.toEqual({
        ticketId,
        skipped: true,
      });

      expect(h.calls).toEqual(["getTicket"]);
      expect(h.aiInputs).toEqual([]);
    },
  );

  it("aborts naming the ID for an unknown ticket and writes nothing", async () => {
    const h = harness({ found: null });

    const run = runTriageTicket({ ticketId }, h.deps);
    await expect(run).rejects.toBeInstanceOf(AbortTaskRunError);
    await expect(run).rejects.toThrow(ticketId);
    expect(h.calls).toEqual(["getTicket"]);
  });

  it.each([
    ["status new", { found: ticket("new") }, /status new/],
    ["status failed", { found: ticket("failed") }, /status failed/],
    ["an unknown status, not echoed", { found: ticket("weird-value") }, /\(unknown status\)/],
    ["no redaction", { redaction: null }, /no redaction/],
    ["no triage row", { triage: null }, /no triage row/],
  ] as const)(
    "aborts for %s, naming the reason, and writes nothing",
    async (_, options, reason) => {
      const h = harness(options);

      const error: unknown = await runTriageTicket({ ticketId }, h.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AbortTaskRunError);
      expect((error as Error).message).toMatch(reason);
      expect((error as Error).message).not.toContain("weird-value");
      expect(h.writes()).toEqual([]);
      expect(h.aiInputs).toEqual([]);
    },
  );

  it.each(["judge", "searchKb", "rerank", "draft", "grounding", "saveTriageResult"] as const)(
    "when %s throws, the run throws with no triage write, no event and no status change",
    async (fail) => {
      const h = harness({ fail });

      await expect(runTriageTicket({ ticketId }, h.deps)).rejects.toThrow(`${fail} failed`);

      expect(h.saved).toEqual([]);
      expect(h.events).toEqual([]);
      expect(h.statuses).toEqual([]);
      expect(h.deps.repos.setTicketStatus).not.toHaveBeenCalled();
    },
  );

  it("event payloads hold IDs, counts and names only", async () => {
    const h = harness({ grounding: { score: 0.2, flagged: true } });

    await runTriageTicket({ ticketId }, h.deps);

    expect(h.events).toEqual([
      {
        type: "kb_matched",
        payload: { articleIds: h.candidates.map((c) => c.id), count: 3 },
      },
      { type: "fix_drafted", payload: { steps: 2 } },
      { type: "policy_decided", payload: { route: "review", reasons: ["ungrounded_fix"] } },
      { type: "triaged", payload: { route: "review" } },
    ]);
    const json = JSON.stringify(h.events);
    for (const text of [...Object.values(MARKERS), REDACTED.title, ...draft.steps]) {
      expect(json).not.toContain(text);
    }
  });

  it("never logs ticket text, raw or redacted", async () => {
    const runs = [
      harness(),
      harness({ triage: triageRow(true) }),
      harness({ found: ticket("triaged") }),
      harness({ found: ticket("new") }),
      harness({ redaction: null }),
    ];
    for (const h of runs) await runTriageTicket({ ticketId }, h.deps).catch(() => undefined);

    const logged = JSON.stringify(runs.flatMap((h) => h.logs));
    expect(logged).toContain(ticketId);
    for (const text of [
      ...Object.values(MARKERS),
      REDACTED.title,
      REDACTED.description,
      ...draft.steps,
      "Content of article",
    ]) {
      expect(logged).not.toContain(text);
    }
  });
});

const WRITE_POSITIONS = [
  "saveTriageResult",
  "event:kb_matched",
  "event:fix_drafted",
  "event:policy_decided",
  "event:triaged",
  "status:triaged",
];

describe("triage-ticket retry after a failed write", () => {
  // Sensitive and ungrounded, so the policy_decided reasons are not trivial.
  const options = { triage: triageRow(true), grounding: { score: 0.2, flagged: true } };

  it.each(WRITE_POSITIONS)(
    "a failure at %s, then a second attempt: one save, one of each event, status triaged",
    async (fail) => {
      const h = harness({ ...options, fail, failOnce: true });

      await expect(runTriageTicket({ ticketId }, h.deps, 1)).rejects.toThrow(`${fail} failed`);
      const aiBefore = h.aiCalls();
      await expect(runTriageTicket({ ticketId }, h.deps, 2)).resolves.toMatchObject({
        skipped: false,
        route: "review",
        reasons: ["sensitive", "ungrounded_fix"],
      });

      expect(h.saved).toHaveLength(1);
      expect(h.events).toEqual([
        { type: "kb_matched", payload: { articleIds: h.candidates.map((c) => c.id), count: 3 } },
        { type: "fix_drafted", payload: { steps: 2 } },
        {
          type: "policy_decided",
          payload: { route: "review", reasons: ["sensitive", "ungrounded_fix"] },
        },
        { type: "triaged", payload: { route: "review" } },
      ]);
      expect(h.statuses).toEqual(["triaged"]);
      // The save failed: nothing to resume, so the AI steps run again. Otherwise none run.
      expect(h.aiCalls() - aiBefore).toBe(fail === "saveTriageResult" ? AI_STEPS.length : 0);
    },
  );

  it("a third attempt after the resumed success is skipped", async () => {
    const h = harness({ ...options, fail: "event:fix_drafted", failOnce: true });
    await runTriageTicket({ ticketId }, h.deps).catch(() => undefined);
    await runTriageTicket({ ticketId }, h.deps);
    const before = h.calls.length;

    await expect(runTriageTicket({ ticketId }, h.deps)).resolves.toEqual({
      ticketId,
      skipped: true,
    });
    expect(h.calls.slice(before)).toEqual(["getTicket"]);
  });

  it("a failure before the save makes the retry run every AI step again", async () => {
    const h = harness({ fail: "draft", failOnce: true });

    await expect(runTriageTicket({ ticketId }, h.deps)).rejects.toThrow("draft failed");
    expect(h.writes()).toEqual([]);
    const aiBefore = h.aiCalls();
    await runTriageTicket({ ticketId }, h.deps, 2);

    expect(h.aiCalls() - aiBefore).toBe(AI_STEPS.length);
    expect(h.saved).toHaveLength(1);
    expect(h.events.map((e) => e.type)).toEqual([
      "kb_matched",
      "fix_drafted",
      "policy_decided",
      "triaged",
    ]);
    expect(h.statuses).toEqual(["triaged"]);
  });

  it("a saved row with a missing probability throws on resume and writes nothing", async () => {
    const h = harness({
      triage: {
        ...triageRow(false),
        route: "auto",
        priority: "P3",
        probabilities: { category: 0.9 },
        flags: [],
        kb_article_ids: [],
        suggested_fix: { steps: ["a"], caveats: [] },
        triaged_at: now,
      },
    });

    await expect(runTriageTicket({ ticketId }, h.deps)).rejects.toThrow(/injection/);
    expect(h.aiCalls()).toBe(0);
    expect(h.writes()).toEqual([]);
  });
});

describe("triage-ticket department privacy (real judge)", () => {
  const DEPT_MARKER = "deptmarker4471@example.test";

  function judgeResponse() {
    const choiceAnswer = (labels: readonly string[], value: string) => ({
      type: "choice",
      choice: value,
      confidence: 0.9,
      probabilities: Object.fromEntries(labels.map((l) => [l, l === value ? 0.9 : 0.02])),
    });
    return {
      model: "jev-reported-1",
      answers: {
        category: choiceAnswer(CATEGORIES, "network"),
        priority: choiceAnswer(PRIORITIES, "P3"),
        urgency: choiceAnswer(URGENCIES, "medium"),
        assignment_group: choiceAnswer(ASSIGNMENT_GROUPS, "Network"),
        outage_or_duplicate: { type: "noul", noul: 0.05 },
        injection: { type: "noul", noul: 0.01 },
        actionable: { type: "noul", noul: 0.9 },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    };
  }

  it("the department reaches the judge only through its own redact()", async () => {
    const h = harness({ found: { ...ticket(), department: `Finance ${DEPT_MARKER}` } });
    const requests: unknown[] = [];
    const runtime = {
      call: async (meta: { input: unknown }, fn: () => Promise<unknown>) => {
        requests.push(meta.input);
        return fn();
      },
    } as unknown as TriageJudgeDeps["runtime"];
    const client = {
      systemOne: async (request: unknown) => {
        requests.push(request);
        return judgeResponse();
      },
    } as unknown as TriageJudgeDeps["client"];
    h.deps.judge = createTriageJudge({
      client,
      runtime,
    });

    await runTriageTicket({ ticketId }, h.deps);

    expect(requests.length).toBeGreaterThan(0);
    const sent = JSON.stringify([...requests, ...h.aiInputs]);
    expect(sent).toContain("Finance");
    for (const marker of [DEPT_MARKER, "deptmarker4471", ...Object.values(MARKERS)]) {
      expect(sent).not.toContain(marker);
    }
    expect(JSON.stringify(h.logs)).not.toContain("deptmarker4471");
  });
});

describe("triageTicketPayload", () => {
  it("rejects {} with an error naming ticketId", () => {
    expect(() => triageTicketPayload.parse({})).toThrow(/ticketId/);
  });

  it("rejects a ticketId that is not a uuid", () => {
    expect(triageTicketPayload.safeParse({ ticketId: "123" }).success).toBe(false);
  });

  it("accepts a uuid ticketId with optional test overrides", () => {
    expect(triageTicketPayload.parse({ ticketId })).toEqual({ ticketId });
    expect(triageTicketPayload.parse({ ticketId, testOverrides: { llmCallCap: 0 } })).toEqual({
      ticketId,
      testOverrides: { llmCallCap: 0 },
    });
  });

  it("rejects an unknown test switch", () => {
    expect(
      triageTicketPayload.safeParse({ ticketId, testOverrides: { unknown: true } }).success,
    ).toBe(false);
  });
});

describe("createTriageDeps", () => {
  const env = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "k".repeat(16),
    SUPABASE_DB_SCHEMA: "itsupport",
    TYPESAFE_API_KEY: "t".repeat(16),
    LLM_API_KEY: "l".repeat(16),
    LLM_BASE_URL: "https://llm.example.test/v1",
    LLM_MODEL: "test-model",
    LANGFUSE_PUBLIC_KEY: "p".repeat(8),
    LANGFUSE_SECRET_KEY: "s".repeat(8),
    LANGFUSE_BASE_URL: "https://langfuse.example.test",
  };

  it("builds deps with the default policy thresholds", () => {
    const deps = createTriageDeps(env);
    expect(deps.thresholds).toEqual({
      TRIAGE_CONFIDENCE_MIN: 0.7,
      INJECTION_THRESHOLD: 0.5,
      NEEDS_INFO_THRESHOLD: 0.5,
      OUTAGE_THRESHOLD: 0.5,
    });
    expect(typeof deps.judge.judge).toBe("function");
    expect(typeof deps.reranker.rerankKb).toBe("function");
    expect(typeof deps.drafter.draft).toBe("function");
    expect(typeof deps.grounding.scoreGrounding).toBe("function");
  });

  it.each([
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "TYPESAFE_API_KEY",
    "SUPABASE_URL",
    "LANGFUSE_SECRET_KEY",
  ] as const)("fails naming %s when it is missing", (name) => {
    expect(() => createTriageDeps({ ...env, [name]: undefined })).toThrow(new RegExp(name));
  });

  it("fails naming GROUNDING_MIN and TRIAGE_CONFIDENCE_MIN when invalid, without echoing the key", () => {
    const run = () => createTriageDeps({ ...env, GROUNDING_MIN: "2", TRIAGE_CONFIDENCE_MIN: "x" });
    expect(run).toThrow(/GROUNDING_MIN/);
    expect(run).toThrow(/TRIAGE_CONFIDENCE_MIN/);
    expect(run).not.toThrow(new RegExp(env.LLM_API_KEY));
  });
});
