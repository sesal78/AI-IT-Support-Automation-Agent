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
import {
  BudgetExceededError,
  LlmUnavailableError,
  createAiRuntime,
  createLangfuseSink,
  createTriageJudge,
  type TraceSpan,
  type TriageJudgeDeps,
} from "@ai-it-support/ai";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createSwitchableSink,
  createTriageDeps,
  createTriageFailureDeps,
  onTriageFailure,
  runTriageTicket,
  triageTicket,
  triageTicketOptions,
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

function ticket(status = "redacted", isTest = false): Ticket {
  return {
    id: ticketId,
    source: "web",
    raw_title: `${MARKERS.title} VPN drops`,
    raw_description: `${MARKERS.description} call 0491 570 156`,
    requester_email: MARKERS.email,
    requester_name: MARKERS.name,
    department: "Finance",
    status,
    servicenow_sys_id: null,
    servicenow_number: null,
    idempotency_key: "key-1",
    is_test: isTest,
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
  /** The ticket's is_test and the env E2E_MODE. */
  isTest?: boolean;
  e2eMode?: boolean;
  /** Thrown by the judge on every call. */
  judgeError?: () => Error;
  /** Thrown by the reranker / grounding scorer on every call. */
  rerankError?: () => Error;
  groundingError?: () => Error;
  /** Thrown by the drafter when it returns an error for the input. */
  draftError?: (input: { capOverride?: number }) => Error | undefined;
}

const AI_STEPS = ["judge", "searchKb", "rerank", "draft", "grounding"];

function harness(options: Options = {}) {
  const calls: string[] = [];
  const aiInputs: unknown[] = [];
  const logs: unknown[][] = [];
  const saved: TriageResult[] = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const statuses: string[] = [];
  const alerts: Array<[string, unknown]> = [];
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
        return options.found === undefined ? ticket(status, options.isTest) : options.found;
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
        if (options.judgeError) throw options.judgeError();
        return judgments;
      }),
    },
    reranker: {
      rerankKb: vi.fn(async (input: KbRerankInput) => {
        step("rerank", input);
        if (options.rerankError) throw options.rerankError();
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
        const error = options.draftError?.(input);
        if (error) throw error;
        return draft;
      }),
    },
    grounding: {
      scoreGrounding: vi.fn(async (input) => {
        step("grounding", input);
        if (options.groundingError) throw options.groundingError();
        return options.grounding ?? { score: 0.9, flagged: false };
      }),
    },
    thresholds: {
      TRIAGE_CONFIDENCE_MIN: 0.7,
      INJECTION_THRESHOLD: 0.5,
      NEEDS_INFO_THRESHOLD: 0.5,
      OUTAGE_THRESHOLD: 0.5,
    },
    e2eMode: options.e2eMode ?? false,
    alert: vi.fn(async (kind: string, alertOptions?: unknown) => {
      alerts.push([kind, alertOptions]);
    }),
    setTraceSinkDown: vi.fn(),
    logger: { info: log, warn: log, error: log },
  };
  const aiCalls = () => calls.filter((c) => AI_STEPS.includes(c)).length;
  const writes = () =>
    calls.filter(
      (c) => c.startsWith("event:") || c.startsWith("status:") || c === "saveTriageResult",
    );
  const count = (name: string) => calls.filter((c) => c === name).length;
  const failureDeps = () => ({ repos: deps.repos, alert: deps.alert, logger: deps.logger });
  return {
    deps,
    calls,
    aiInputs,
    logs,
    saved,
    events,
    statuses,
    alerts,
    candidates,
    writes,
    aiCalls,
    count,
    failureDeps,
    triage: () => triageState,
  };
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
      "listEventTypes",
      "judge",
      "searchKb",
      "rerank",
      "draft",
      "grounding",
      "saveTriageResult",
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
    expect(sent).not.toContain("0491 570 156");
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

const llmCap = () => new BudgetExceededError("llm");
const typesafeCap = () => new BudgetExceededError("typesafe");
const llm429 = () => new LlmUnavailableError();
const types = (h: ReturnType<typeof harness>) => h.events.map((e) => e.type);

describe("triage-ticket LLM cap (BudgetExceededError from the drafter)", () => {
  it("ends triaged, route review, reason cap_reached, no fix, no grounding, event llm_cap_reached", async () => {
    const h = harness({ draftError: llmCap });

    const result = await runTriageTicket({ ticketId }, h.deps);

    expect(result).toEqual({ ticketId, skipped: false, route: "review", reasons: ["cap_reached"] });
    expect(types(h)).toEqual(["llm_cap_reached", "kb_matched", "policy_decided", "triaged"]);
    expect(types(h)).not.toContain("fix_drafted");
    expect(h.events[0]).toEqual({ type: "llm_cap_reached", payload: {} });
    expect(h.deps.grounding.scoreGrounding).not.toHaveBeenCalled();
    expect(h.count("draft")).toBe(1);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      route: "review",
      category: "network",
      suggestedFix: null,
      groundingScore: null,
      modelVersions: { typesafe: "jev-reported-1" },
    });
    expect(h.saved[0]!.modelVersions).not.toHaveProperty("llm");
    expect(h.statuses).toEqual(["triaged"]);
    // The meter raises the cap alerts; this path adds none.
    expect(h.alerts).toEqual([]);
  });

  it("keeps sensitive first and adds cap_reached", async () => {
    const h = harness({ triage: triageRow(true), draftError: llmCap });

    await expect(runTriageTicket({ ticketId }, h.deps)).resolves.toMatchObject({
      route: "review",
      reasons: ["sensitive", "cap_reached"],
    });
    expect(h.events.find((e) => e.type === "policy_decided")?.payload).toEqual({
      route: "review",
      reasons: ["sensitive", "cap_reached"],
    });
  });

  it("a TypeSafe BudgetExceededError from the drafter is not taken for the LLM cap", async () => {
    const h = harness({ draftError: typesafeCap });

    await expect(runTriageTicket({ ticketId }, h.deps)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(h.writes()).toEqual([]);
  });
});

describe("triage-ticket test switch llmCallCap", () => {
  // The drafter fake refuses like the real meter when the cap is 0.
  const refuseAtZero = (input: { capOverride?: number }) =>
    input.capOverride === 0 ? llmCap() : undefined;
  const payload = { ticketId, testOverrides: { llmCallCap: 0 } };

  it("E2E_MODE=true and is_test: the drafter gets the cap 0 and the run ends capped", async () => {
    const h = harness({ e2eMode: true, isTest: true, draftError: refuseAtZero });

    await expect(runTriageTicket(payload, h.deps)).resolves.toMatchObject({
      route: "review",
      reasons: ["cap_reached"],
    });
    expect(vi.mocked(h.deps.drafter.draft).mock.calls[0]![0].capOverride).toBe(0);
    expect(types(h)).toContain("llm_cap_reached");
  });

  it("passes a non-zero cap through unchanged", async () => {
    const h = harness({ e2eMode: true, isTest: true });

    await runTriageTicket({ ticketId, testOverrides: { llmCallCap: 7 } }, h.deps);
    expect(vi.mocked(h.deps.drafter.draft).mock.calls[0]![0].capOverride).toBe(7);
  });

  it.each([
    ["E2E_MODE=false", { e2eMode: false, isTest: true }],
    ["is_test = false", { e2eMode: true, isTest: false }],
    ["neither", { e2eMode: false, isTest: false }],
  ])("%s: the switch is ignored and the drafter uses the env cap", async (_, flags) => {
    const h = harness({ ...flags, draftError: refuseAtZero });

    await expect(runTriageTicket(payload, h.deps)).resolves.toMatchObject({ route: "auto" });
    expect(vi.mocked(h.deps.drafter.draft).mock.calls[0]![0]).not.toHaveProperty("capOverride");
    expect(types(h)).not.toContain("llm_cap_reached");
  });

  it.each([
    ["-1", -1],
    ["NaN", Number.NaN],
    ["1.5", 1.5],
    ["100001", 100_001],
    ["1e12", 1e12],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("llmCallCap %s is rejected by the payload schema", (_, value) => {
    expect(
      triageTicketPayload.safeParse({ ticketId, testOverrides: { llmCallCap: value } }).success,
    ).toBe(false);
  });

  it.each([
    ["-1", { llmCallCap: -1 }],
    ["NaN", { llmCallCap: Number.NaN }],
    ["1e12", { llmCallCap: 1e12 }],
    ["an unknown switch", { asleep: true }],
  ])(
    "llmCallCap %s past the schema aborts with no AI call and no write, even outside e2e mode",
    async (_, testOverrides) => {
      for (const flags of [
        { e2eMode: true, isTest: true },
        { e2eMode: false, isTest: false },
      ]) {
        const h = harness(flags);
        const bad = { ticketId, testOverrides } as unknown as Parameters<typeof runTriageTicket>[0];

        const error: unknown = await runTriageTicket(bad, h.deps).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AbortTaskRunError);
        expect((error as Error).message).toMatch(/invalid test overrides/);
        expect(h.aiCalls()).toBe(0);
        expect(h.writes()).toEqual([]);
      }
    },
  );
});

describe("triage-ticket LLM 429 (LlmUnavailableError)", () => {
  it("one drafter call, event and one alert llm_unavailable, ends triaged with route review", async () => {
    const h = harness({ draftError: llm429 });

    await expect(runTriageTicket({ ticketId }, h.deps)).resolves.toEqual({
      ticketId,
      skipped: false,
      route: "review",
      reasons: ["llm_unavailable"],
    });
    expect(h.count("draft")).toBe(1);
    expect(types(h)).toEqual(["llm_unavailable", "kb_matched", "policy_decided", "triaged"]);
    expect(h.alerts).toEqual([["llm_unavailable", { ticketId }]]);
    expect(h.deps.grounding.scoreGrounding).not.toHaveBeenCalled();
    expect(h.saved[0]).toMatchObject({ route: "review", suggestedFix: null, groundingScore: null });
    expect(h.statuses).toEqual(["triaged"]);
  });

  it("any other LLM error still fails the run with no write", async () => {
    const h = harness({ draftError: () => new Error("boom") });

    await expect(runTriageTicket({ ticketId }, h.deps)).rejects.toThrow("boom");
    expect(h.writes()).toEqual([]);
    expect(h.alerts).toEqual([]);
  });
});

describe("triage-ticket TypeSafe cap at the judgments", () => {
  it("event and one alert typesafe_cap_reached, no LLM call, triaged, route review, null category", async () => {
    const h = harness({ judgeError: typesafeCap });

    await expect(runTriageTicket({ ticketId }, h.deps)).resolves.toEqual({
      ticketId,
      skipped: false,
      route: "review",
      reasons: ["cap_reached"],
    });
    expect(types(h)).toEqual(["typesafe_cap_reached", "policy_decided", "triaged"]);
    expect(h.alerts).toEqual([["typesafe_cap_reached", { ticketId }]]);
    expect(h.deps.drafter.draft).not.toHaveBeenCalled();
    expect(h.deps.repos.searchKb).not.toHaveBeenCalled();
    expect(h.deps.reranker.rerankKb).not.toHaveBeenCalled();
    expect(h.deps.grounding.scoreGrounding).not.toHaveBeenCalled();
    expect(h.saved).toEqual([
      {
        category: null,
        subcategory: null,
        priority: null,
        urgency: null,
        assignmentGroup: null,
        route: "review",
        probabilities: {},
        flags: [],
        groundingScore: null,
        kbArticleIds: [],
        suggestedFix: null,
        modelVersions: {},
      },
    ]);
    expect(h.statuses).toEqual(["triaged"]);
  });

  it("a sensitive ticket keeps sensitive first", async () => {
    const h = harness({ triage: triageRow(true), judgeError: typesafeCap });

    await expect(runTriageTicket({ ticketId }, h.deps)).resolves.toMatchObject({
      route: "review",
      reasons: ["sensitive", "cap_reached"],
    });
  });

  it("an LLM BudgetExceededError from the judge is not taken for the TypeSafe cap", async () => {
    const h = harness({ judgeError: llmCap });

    await expect(runTriageTicket({ ticketId }, h.deps)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(h.writes()).toEqual([]);
  });
});

describe("triage-ticket TypeSafe cap at the rerank or the grounding", () => {
  it("cap at the rerank: triaged, review, cap_reached, event and alert once, no article, no draft, no grounding", async () => {
    const h = harness({ rerankError: typesafeCap });

    await expect(runTriageTicket({ ticketId }, h.deps)).resolves.toEqual({
      ticketId,
      skipped: false,
      route: "review",
      reasons: ["cap_reached"],
    });
    expect(types(h)).toEqual(["typesafe_cap_reached", "kb_matched", "policy_decided", "triaged"]);
    expect(h.events.find((e) => e.type === "kb_matched")?.payload).toEqual({
      articleIds: [],
      count: 0,
    });
    expect(h.alerts).toEqual([["typesafe_cap_reached", { ticketId }]]);
    expect(h.count("rerank")).toBe(1);
    expect(h.deps.drafter.draft).not.toHaveBeenCalled();
    expect(h.deps.grounding.scoreGrounding).not.toHaveBeenCalled();
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      category: "network",
      priority: "P3",
      route: "review",
      kbArticleIds: [],
      suggestedFix: null,
      groundingScore: null,
      modelVersions: { typesafe: "jev-reported-1" },
    });
    expect(h.statuses).toEqual(["triaged"]);
  });

  it("cap at the grounding: triaged, review, ungrounded_fix and cap_reached, steps kept, event once", async () => {
    const h = harness({ groundingError: typesafeCap });

    await expect(runTriageTicket({ ticketId }, h.deps)).resolves.toEqual({
      ticketId,
      skipped: false,
      route: "review",
      reasons: ["ungrounded_fix", "cap_reached"],
    });
    expect(types(h)).toEqual([
      "typesafe_cap_reached",
      "kb_matched",
      "fix_drafted",
      "policy_decided",
      "triaged",
    ]);
    expect(h.alerts).toEqual([["typesafe_cap_reached", { ticketId }]]);
    expect(h.count("draft")).toBe(1);
    expect(h.count("grounding")).toBe(1);
    expect(h.saved[0]).toMatchObject({
      route: "review",
      flags: ["ungrounded_fix"],
      groundingScore: null,
      kbArticleIds: h.candidates.map((c) => c.id),
      suggestedFix: { steps: draft.steps, caveats: draft.caveats },
      modelVersions: { typesafe: "jev-reported-1", llm: "llm-reported-1" },
    });
    expect(h.statuses).toEqual(["triaged"]);
  });

  it.each([
    ["rerank", { rerankError: typesafeCap }],
    ["grounding", { groundingError: typesafeCap }],
  ])("a sensitive ticket capped at the %s keeps sensitive first", async (_, failure) => {
    const h = harness({ triage: triageRow(true), ...failure });

    const result = await runTriageTicket({ ticketId }, h.deps);
    expect(result).toMatchObject({ route: "review" });
    expect((result as { reasons: string[] }).reasons[0]).toBe("sensitive");
    expect((result as { reasons: string[] }).reasons).toContain("cap_reached");
  });

  it.each([
    ["rerank", { rerankError: typesafeCap }, "rerank"],
    ["grounding", { groundingError: typesafeCap }, "draft"],
  ])(
    "capped at the %s, a failed event write then a retry: one event, one alert",
    async (_, failure, rerun) => {
      const h = harness({ ...failure, fail: "event:typesafe_cap_reached", failOnce: true });

      await expect(runTriageTicket({ ticketId }, h.deps, 1)).rejects.toThrow(
        "event:typesafe_cap_reached failed",
      );
      expect(h.alerts).toEqual([]);
      expect(h.saved).toEqual([]);
      await expect(runTriageTicket({ ticketId }, h.deps, 2)).resolves.toMatchObject({
        route: "review",
      });

      expect(types(h).filter((t) => t === "typesafe_cap_reached")).toHaveLength(1);
      expect(h.alerts).toEqual([["typesafe_cap_reached", { ticketId }]]);
      for (const type of new Set(types(h))) {
        expect(types(h).filter((t) => t === type)).toHaveLength(1);
      }
      // Nothing was saved, so the retry runs the AI steps again (the LLM too after a grounding cap).
      expect(h.count(rerun)).toBe(2);
      expect(h.saved).toHaveLength(1);
      expect(h.statuses).toEqual(["triaged"]);
    },
  );

  it.each(["event:policy_decided", "event:triaged", "status:triaged"])(
    "capped at the grounding, a failure at %s, then a resume: same reasons, no AI call, no duplicate",
    async (fail) => {
      const h = harness({ groundingError: typesafeCap, fail, failOnce: true });

      await expect(runTriageTicket({ ticketId }, h.deps, 1)).rejects.toThrow(`${fail} failed`);
      const aiBefore = h.aiCalls();
      await expect(runTriageTicket({ ticketId }, h.deps, 2)).resolves.toMatchObject({
        route: "review",
        reasons: ["ungrounded_fix", "cap_reached"],
      });

      expect(h.aiCalls()).toBe(aiBefore);
      expect(h.alerts).toHaveLength(1);
      for (const type of new Set(types(h))) {
        expect(types(h).filter((t) => t === type)).toHaveLength(1);
      }
      expect(h.statuses).toEqual(["triaged"]);
    },
  );

  it("capped at the rerank, a failure at saveTriageResult, then a retry: fail-safe judgments-cap path, no duplicate", async () => {
    const h = harness({ rerankError: typesafeCap, fail: "saveTriageResult", failOnce: true });

    await expect(runTriageTicket({ ticketId }, h.deps, 1)).rejects.toThrow(
      "saveTriageResult failed",
    );
    await expect(runTriageTicket({ ticketId }, h.deps, 2)).resolves.toMatchObject({
      route: "review",
      reasons: ["cap_reached"],
    });
    expect(h.count("judge")).toBe(1);
    expect(h.count("rerank")).toBe(1);
    expect(h.alerts).toHaveLength(1);
    expect(types(h).filter((t) => t === "typesafe_cap_reached")).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
  });

  it.each([
    ["rerank", "a plain error", { rerankError: () => new Error("rerank boom") }],
    ["grounding", "a plain error", { groundingError: () => new Error("grounding boom") }],
    ["rerank", "an LLM BudgetExceededError", { rerankError: llmCap }],
    ["grounding", "an LLM BudgetExceededError", { groundingError: llmCap }],
  ])("%s throwing %s still fails the run with no write and no alert", async (_, __, failure) => {
    const h = harness(failure);

    await expect(runTriageTicket({ ticketId }, h.deps)).rejects.toThrow();
    expect(h.writes()).toEqual([]);
    expect(h.alerts).toEqual([]);
  });
});

describe("triage-ticket degraded paths across attempts", () => {
  const cases = [
    ["llm_cap_reached", { draftError: llmCap }, "draft", false],
    ["llm_unavailable", { draftError: llm429 }, "draft", true],
    ["typesafe_cap_reached", { judgeError: typesafeCap }, "judge", true],
  ] as const;

  for (const [event, failure, stepName, alerted] of cases) {
    it.each(["saveTriageResult", "event:policy_decided", "event:triaged", "status:triaged"])(
      `${event}: a failure at %s, then a retry: one ${event} event, ${alerted ? "one alert" : "no alert"}, ${stepName} called once`,
      async (fail) => {
        const h = harness({ ...failure, fail, failOnce: true });

        await expect(runTriageTicket({ ticketId }, h.deps, 1)).rejects.toThrow(`${fail} failed`);
        await expect(runTriageTicket({ ticketId }, h.deps, 2)).resolves.toMatchObject({
          route: "review",
        });

        expect(types(h).filter((t) => t === event)).toHaveLength(1);
        expect(h.alerts).toHaveLength(alerted ? 1 : 0);
        expect(h.count(stepName)).toBe(1);
        expect(h.deps.drafter.draft).toHaveBeenCalledTimes(
          event === "typesafe_cap_reached" ? 0 : 1,
        );
        for (const type of new Set(types(h))) {
          expect(types(h).filter((t) => t === type)).toHaveLength(1);
        }
        expect(h.saved).toHaveLength(1);
        expect(h.statuses).toEqual(["triaged"]);
        const policy = h.events.find((e) => e.type === "policy_decided")!.payload;
        expect(policy.route).toBe("review");
        expect(policy.reasons).toEqual([
          event === "llm_unavailable" ? "llm_unavailable" : "cap_reached",
        ]);
      },
    );
  }

  it("a resumed llm-capped result rebuilds the reason cap_reached with no AI call", async () => {
    const h = harness({ draftError: llmCap, fail: "event:policy_decided", failOnce: true });
    await runTriageTicket({ ticketId }, h.deps).catch(() => undefined);
    const aiBefore = h.aiCalls();

    await expect(runTriageTicket({ ticketId }, h.deps, 2)).resolves.toMatchObject({
      reasons: ["cap_reached"],
    });
    expect(h.aiCalls()).toBe(aiBefore);
    expect(types(h)).not.toContain("fix_drafted");
  });

  it("a saved auto route next to a typesafe_cap_reached event throws on resume and writes nothing", async () => {
    const h = harness({
      triage: { ...triageRow(false), route: "auto", triaged_at: now },
    });
    await h.deps.repos.addEvent(ticketId, "typesafe_cap_reached", {});
    const before = h.writes().length;

    await expect(runTriageTicket({ ticketId }, h.deps)).rejects.toThrow(/must route review/);
    expect(h.writes()).toHaveLength(before);
  });
});

describe("triage-ticket test switch langfuseDown (real runtime and sink)", () => {
  const langfuseEnv = {
    LANGFUSE_PUBLIC_KEY: "p".repeat(8),
    LANGFUSE_SECRET_KEY: "s".repeat(8),
    LANGFUSE_BASE_URL: "https://langfuse.example.test",
  };

  function wired(flags: { e2eMode: boolean; isTest: boolean }) {
    const h = harness(flags);
    const upSpans: TraceSpan[] = [];
    const fetchSpy = vi.fn();
    const switchable = createSwitchableSink(
      { record: async (span) => void upSpans.push(span) },
      createLangfuseSink(langfuseEnv, { forceDown: true, fetch: fetchSpy }),
    );
    const runtime = createAiRuntime({
      meter: { run: (_options, fn) => fn() },
      sink: switchable.sink,
      addEvent: h.deps.repos.addEvent,
      environment: "e2e",
      logger: { error: () => undefined },
    });
    h.deps.setTraceSinkDown = vi.fn(switchable.setDown);
    h.deps.judge = {
      judge: (input) =>
        runtime.call(
          { provider: "typesafe", kind: "triage", ticketId, model: "jev", input: {} },
          async () => {
            h.calls.push("judge");
            void input;
            return judgments;
          },
        ),
    };
    return { h, upSpans, fetchSpy };
  }
  const payload = { ticketId, testOverrides: { langfuseDown: true } };

  it("a test ticket in e2e mode ends triaged with at least one trace_export_failed event", async () => {
    const { h, upSpans, fetchSpy } = wired({ e2eMode: true, isTest: true });

    await expect(runTriageTicket(payload, h.deps)).resolves.toMatchObject({ skipped: false });
    expect(h.statuses).toEqual(["triaged"]);
    expect(types(h).filter((t) => t === "trace_export_failed").length).toBeGreaterThanOrEqual(1);
    expect(h.events.find((e) => e.type === "trace_export_failed")!.payload).toEqual({
      kind: "triage",
    });
    expect(upSpans).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-test ticket", { e2eMode: true, isTest: false }],
    ["E2E_MODE=false", { e2eMode: false, isTest: true }],
  ])("%s: the switch is ignored", async (_, flags) => {
    const { h, upSpans } = wired(flags);

    await runTriageTicket(payload, h.deps);
    expect(h.deps.setTraceSinkDown).not.toHaveBeenCalled();
    expect(types(h)).not.toContain("trace_export_failed");
    expect(upSpans).toHaveLength(1);
    expect(h.statuses).toEqual(["triaged"]);
  });
});

describe("triage-ticket degraded paths never log ticket text", () => {
  it("cap, 429 and TypeSafe-cap runs log IDs and names only", async () => {
    const runs = [
      harness({ draftError: llmCap }),
      harness({ draftError: llm429 }),
      harness({ judgeError: typesafeCap }),
    ];
    for (const h of runs) await runTriageTicket({ ticketId }, h.deps);

    const logged = JSON.stringify([
      ...runs.flatMap((h) => h.logs),
      ...runs.flatMap((h) => h.events),
      ...runs.flatMap((h) => h.alerts),
    ]);
    expect(logged).toContain(ticketId);
    for (const text of [
      ...Object.values(MARKERS),
      REDACTED.title,
      REDACTED.description,
      "Content of article",
    ]) {
      expect(logged).not.toContain(text);
    }
  });
});

class DbDownError extends Error {}

describe("onTriageFailure", () => {
  it("records triage_failed with the class name, sets failed, raises one alert; triage columns stay null", async () => {
    const h = harness();

    await onTriageFailure({ payload: { ticketId }, error: new TypeError("x") }, h.failureDeps());

    expect(h.events).toEqual([{ type: "triage_failed", payload: { error: "TypeError" } }]);
    expect(h.statuses).toEqual(["failed"]);
    expect(h.alerts).toEqual([["triage_failed", { ticketId }]]);
    expect(h.saved).toEqual([]);
    const row = h.triage()!;
    for (const column of [
      "category",
      "priority",
      "urgency",
      "assignment_group",
      "route",
      "probabilities",
      "suggested_fix",
      "triaged_at",
    ] as const) {
      expect(row[column]).toBeNull();
    }
  });

  it("names a custom error class and never the message (it may hold ticket text)", async () => {
    const h = harness();

    await onTriageFailure(
      { payload: { ticketId }, error: new DbDownError(MARKERS.title) },
      h.failureDeps(),
    );

    expect(h.events[0]!.payload).toEqual({ error: "DbDownError" });
    expect(JSON.stringify([h.events, h.logs, h.alerts])).not.toContain(MARKERS.title);
  });

  it("after a failed AI step: one triage_failed, status failed, no triage write", async () => {
    const h = harness({ fail: "draft" });
    const error: unknown = await runTriageTicket({ ticketId }, h.deps).catch((e: unknown) => e);

    await onTriageFailure({ payload: { ticketId }, error }, h.failureDeps());

    expect(types(h)).toEqual(["triage_failed"]);
    expect(h.statuses).toEqual(["failed"]);
    expect(h.saved).toEqual([]);
  });

  it.each(["failed", "triaged", "auto", "review_pending", "new"])(
    "changes nothing on a ticket with status %s",
    async (status) => {
      const h = harness({ found: ticket(status) });

      await onTriageFailure({ payload: { ticketId }, error: new Error("x") }, h.failureDeps());

      expect(h.writes()).toEqual([]);
      expect(h.alerts).toEqual([]);
    },
  );

  it("changes nothing on an unknown ticket", async () => {
    const h = harness({ found: null });

    await onTriageFailure({ payload: { ticketId }, error: new Error("x") }, h.failureDeps());
    expect(h.writes()).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it("does not set failed while a saved triage result exists (left for the resumable retry)", async () => {
    const h = harness({ fail: "event:kb_matched" });
    await runTriageTicket({ ticketId }, h.deps).catch(() => undefined);
    expect(h.triage()!.triaged_at).not.toBeNull();
    const writesBefore = h.writes().length;

    await onTriageFailure({ payload: { ticketId }, error: new Error("x") }, h.failureDeps());

    expect(h.writes()).toHaveLength(writesBefore);
    expect(h.statuses).toEqual([]);
    expect(types(h)).not.toContain("triage_failed");
    expect(h.alerts).toEqual([]);
  });

  it.each(["getTicket", "getTriage", "addEvent", "setTicketStatus"] as const)(
    "the database is down at %s: logs the class names and does not throw",
    async (method) => {
      const h = harness();
      vi.mocked(h.deps.repos[method]).mockRejectedValue(new DbDownError("connection refused"));

      await expect(
        onTriageFailure({ payload: { ticketId }, error: new TypeError("x") }, h.failureDeps()),
      ).resolves.toBeUndefined();

      const logged = JSON.stringify(h.logs);
      expect(logged).toContain("DbDownError");
      expect(logged).toContain("TypeError");
      expect(logged).not.toContain("connection refused");
    },
  );

  it("does not throw when the logger throws too", async () => {
    const h = harness();
    vi.mocked(h.deps.repos.getTicket).mockRejectedValue(new DbDownError());
    const boom = () => {
      throw new Error("log down");
    };
    const deps = { ...h.failureDeps(), logger: { info: boom, warn: boom, error: boom } };

    await expect(
      onTriageFailure({ payload: { ticketId }, error: new Error("x") }, deps),
    ).resolves.toBeUndefined();
  });

  it.each([{}, { ticketId: "not-a-uuid" }, null, "x"])(
    "a payload without a valid ticket id touches no database: %j",
    async (payload) => {
      const h = harness();

      await onTriageFailure({ payload, error: new Error("x") }, h.failureDeps());
      expect(h.calls).toEqual([]);
    },
  );

  it("is the task's onFailure hook", () => {
    expect(triageTicketOptions.onFailure).toBe(onTriageFailure);
    expect(triageTicketOptions.id).toBe("triage-ticket");
    expect(triageTicketOptions.schema).toBe(triageTicketPayload);
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

  it("reads E2E_MODE and exposes the alert and the trace-sink switch", () => {
    expect(createTriageDeps(env).e2eMode).toBe(false);
    const deps = createTriageDeps({ ...env, E2E_MODE: "true" });
    expect(deps.e2eMode).toBe(true);
    expect(typeof deps.alert).toBe("function");
    expect(() => deps.setTraceSinkDown(true)).not.toThrow();
  });

  it("createTriageFailureDeps needs the database variables only", () => {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_SCHEMA } = env;
    const deps = createTriageFailureDeps({
      SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_DB_SCHEMA,
    });
    expect(typeof deps.repos.setTicketStatus).toBe("function");
    expect(typeof deps.alert).toBe("function");
    expect(() => createTriageFailureDeps({ ...env, SUPABASE_URL: undefined })).toThrow(
      /SUPABASE_URL/,
    );
  });

  it("onTriageFailure with no deps and no database env does not throw", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    try {
      await expect(
        onTriageFailure({ payload: { ticketId }, error: new Error("x") }),
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails naming GROUNDING_MIN and TRIAGE_CONFIDENCE_MIN when invalid, without echoing the key", () => {
    const run = () => createTriageDeps({ ...env, GROUNDING_MIN: "2", TRIAGE_CONFIDENCE_MIN: "x" });
    expect(run).toThrow(/GROUNDING_MIN/);
    expect(run).toThrow(/TRIAGE_CONFIDENCE_MIN/);
    expect(run).not.toThrow(new RegExp(env.LLM_API_KEY));
  });
});
