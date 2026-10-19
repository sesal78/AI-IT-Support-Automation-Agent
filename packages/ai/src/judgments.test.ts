import { ASSIGNMENT_GROUPS, CATEGORIES } from "@ai-it-support/shared";
import { AuthenticationError, InternalServerError, TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { TriageParseError, createTriageJudge, parseTriageResponse } from "./judgments.js";
import { BudgetExceededError, createMeter, type MeterRepos } from "./meter.js";
import { createAiRuntime, type TraceSpan } from "./trace.js";
import { TYPESAFE_MODEL } from "./typesafe-model.js";

const TICKET = "00000000-0000-4000-8000-000000000001";
const FAKE_KEY = "k".repeat(16);
const TITLE_MARKER = "q".repeat(12);
const DESCRIPTION_MARKER = "x".repeat(12);
const DEPARTMENT_MARKER = "w".repeat(12);

function choiceAnswer(labels: readonly string[], chosen: string, chosenP: number) {
  const rest = (1 - chosenP) / (labels.length - 1);
  return {
    type: "choice",
    choice: chosen,
    confidence: 0.5,
    probabilities: Object.fromEntries(labels.map((l) => [l, l === chosen ? chosenP : rest])),
  };
}

function validResponse() {
  return {
    model: "jev-1.13.0",
    answers: {
      category: choiceAnswer(CATEGORIES, "network", 0.75),
      priority: choiceAnswer(["P1", "P2", "P3", "P4"], "P3", 0.5),
      urgency: choiceAnswer(["high", "medium", "low"], "medium", 0.5),
      assignment_group: choiceAnswer(ASSIGNMENT_GROUPS, "Network", 0.75),
      outage_or_duplicate: { type: "noul", noul: 0.1 },
      injection: { type: "noul", noul: 0.05 },
      actionable: { type: "noul", noul: 0.2 },
    },
    usage: { input_tokens: 321, output_tokens: 7 },
  };
}

interface Captured {
  method: string;
  url: string;
  body: {
    state: unknown;
    model?: string;
    questions: Record<string, { type: string; instructions: unknown; criteria?: unknown }>;
  };
}

function setup(options: { status?: number[]; body?: unknown; allowed?: boolean } = {}) {
  const captured: Captured[] = [];
  const statuses = [...(options.status ?? [200])];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    captured.push({
      method: init?.method ?? "GET",
      url: input,
      body: JSON.parse(String(init?.body)),
    });
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    const body = status === 200 ? (options.body ?? validResponse()) : { detail: "error" };
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
      usedCalls: 7,
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
  const sink = { record: vi.fn(async (span: TraceSpan) => void spans.push(span)) };
  const runtime = createAiRuntime({
    meter,
    sink,
    addEvent: vi.fn(async () => undefined),
    environment: "e2e",
    logger: { error: vi.fn() },
  });
  const judge = createTriageJudge({ client, runtime });
  return { judge, captured, repos, spans, fetch };
}

const input = {
  ticketId: TICKET,
  title: `VPN ${TITLE_MARKER}`,
  description: `It drops ${DESCRIPTION_MARKER}`,
  department: `Finance ${DEPARTMENT_MARKER}`,
};

describe("createTriageJudge", () => {
  it("sends one systemOne request with the ticket as state and the 7 questions", async () => {
    const { judge, captured } = setup();
    await judge.judge(input);

    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request!.method).toBe("POST");
    expect(request!.url).toMatch(/\/v1\/systemone$/);
    expect(request!.body.state).toEqual({
      ticket: { title: input.title, description: input.description, department: input.department },
    });
    expect(Object.keys(request!.body.questions).sort()).toEqual(
      [
        "actionable",
        "assignment_group",
        "category",
        "injection",
        "outage_or_duplicate",
        "priority",
        "urgency",
      ].sort(),
    );
    const { questions } = request!.body;
    expect(Object.keys(questions.category!.criteria as object).sort()).toEqual(
      [...CATEGORIES].sort(),
    );
    expect(Object.keys(questions.assignment_group!.criteria as object).sort()).toEqual(
      [...ASSIGNMENT_GROUPS].sort(),
    );
    expect(Object.keys(questions.priority!.criteria as object)).toEqual(["P1", "P2", "P3", "P4"]);
    for (const question of Object.values(questions)) {
      expect(question.instructions).toContain("`ticket`");
    }
  });

  it("never puts ticket text into the instructions or criteria", async () => {
    const { judge, captured } = setup();
    await judge.judge(input);
    const questions = JSON.stringify(captured[0]!.body.questions);
    for (const marker of [TITLE_MARKER, DESCRIPTION_MARKER, DEPARTMENT_MARKER]) {
      expect(questions).not.toContain(marker);
    }
  });

  it("redacts the department", async () => {
    const { judge, captured } = setup();
    await judge.judge({ ...input, department: "Finance, call 0491 570 156" });
    expect(captured[0]!.body.state).toMatchObject({
      ticket: { department: "Finance, call [REDACTED_PHONE]" },
    });
  });

  it("passes a null department through", async () => {
    const { judge, captured } = setup();
    await judge.judge({ ...input, department: null });
    expect(captured[0]!.body.state).toMatchObject({ ticket: { department: null } });
  });

  it("pins the model from the code constant", async () => {
    const { judge, captured } = setup();
    await judge.judge(input);
    expect(TYPESAFE_MODEL).toMatch(/^jev-\d+\.\d+\.\d+$/);
    expect(captured[0]!.body.model).toBe(TYPESAFE_MODEL);
  });

  it("returns the judgments with chosen-label probabilities and needsInfo", async () => {
    const { judge } = setup();
    const result = await judge.judge(input);
    expect(result.category.value).toBe("network");
    expect(result.category.probability).toBe(0.75);
    expect(result.category.confidence).toBe(0.5);
    expect(result.category.probabilities).toEqual(validResponse().answers.category.probabilities);
    expect(result.assignmentGroup.value).toBe("Network");
    expect(result.priority.value).toBe("P3");
    expect(result.urgency.value).toBe("medium");
    expect(result.outageOrDuplicate).toBe(0.1);
    expect(result.injection).toBe(0.05);
    expect(result.needsInfo).toBe(0.8);
    expect(result).toMatchObject({ model: "jev-1.13.0", tokensIn: 321, tokensOut: 7 });
  });

  it("reports the model the API returns, not the constant", async () => {
    const { judge } = setup({ body: { ...validResponse(), model: "jev-9.9.9" } });
    const result = await judge.judge(input);
    expect(result.model).toBe("jev-9.9.9");
  });

  it("meters 7 typesafe calls of kind triage_judgments and records the span", async () => {
    const { judge, repos, spans, captured } = setup();
    await judge.judge(input);
    expect(repos.reserveAiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "typesafe",
        kind: "triage_judgments",
        calls: 7,
        ticketId: TICKET,
      }),
    );
    expect(repos.completeAiCall).toHaveBeenCalledWith(expect.any(String), {
      tokensIn: 321,
      tokensOut: 7,
    });
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span).toMatchObject({
      provider: "typesafe",
      kind: "triage_judgments",
      model: "jev-1.13.0",
      tokensIn: 321,
      tokensOut: 7,
    });
    expect(span.output).toMatchObject({ model: "jev-1.13.0" });
    // The span input is exactly the request sent.
    expect(JSON.parse(JSON.stringify(span.input))).toEqual(captured[0]!.body);
  });

  it("throws BudgetExceededError and sends no request when the budget is refused", async () => {
    const { judge, fetch, spans } = setup({ allowed: false });
    await expect(judge.judge(input)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetch).not.toHaveBeenCalled();
    expect(spans).toHaveLength(0);
  });

  it("rethrows a 401", async () => {
    const { judge, captured } = setup({ status: [401] });
    await expect(judge.judge(input)).rejects.toBeInstanceOf(AuthenticationError);
    expect(captured).toHaveLength(1);
  });

  it("rethrows a 500 that outlasts the SDK retries", async () => {
    const { judge, captured, spans } = setup({ status: [500] });
    await expect(judge.judge(input)).rejects.toBeInstanceOf(InternalServerError);
    expect(captured).toHaveLength(3);
    expect(spans[0]?.error).toBe("InternalServerError");
  });

  it("rethrows a TriageParseError for a bad answer shape", async () => {
    const bad = validResponse();
    (bad.answers.injection as { noul: unknown }).noul = "0.9";
    const { judge } = setup({ body: bad });
    await expect(judge.judge(input)).rejects.toBeInstanceOf(TriageParseError);
  });
});

// T3.U.04
describe("parseTriageResponse", () => {
  type Mutate = (r: ReturnType<typeof validResponse>) => void;
  const answers = (r: ReturnType<typeof validResponse>) =>
    r.answers as unknown as Record<string, Record<string, unknown>>;

  it("parses a valid answer set", () => {
    expect(() => parseTriageResponse(validResponse())).not.toThrow();
  });

  const cases: Array<[string, Mutate, string]> = [
    [
      "an unknown category label",
      (r) => void (answers(r).category!.choice = "printer"),
      "answers.category.choice",
    ],
    [
      "an extra field in an answer",
      (r) => void (answers(r).actionable!.reason = "because"),
      "answers.actionable",
    ],
    ["a wrong type", (r) => void (answers(r).injection!.noul = "0.9"), "answers.injection.noul"],
    ["a missing answer", (r) => void delete answers(r).urgency, "answers.urgency"],
    [
      "a probability of 1.2",
      (r) => void (answers(r).outage_or_duplicate!.noul = 1.2),
      "answers.outage_or_duplicate.noul",
    ],
    [
      "a probabilities object that misses a label",
      (r) => void delete (answers(r).priority!.probabilities as Record<string, number>).P4,
      "answers.priority.probabilities.P4",
    ],
  ];

  it.each(cases)("throws TriageParseError for %s", (_name, mutate, path) => {
    const response = validResponse();
    mutate(response);
    const error = (() => {
      try {
        parseTriageResponse(response);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(TriageParseError);
    expect((error as TriageParseError).paths).toContain(path);
  });

  it("puts field paths only in the message, never values or ticket text", () => {
    const response = validResponse();
    answers(response).category!.choice = DESCRIPTION_MARKER;
    answers(response).injection!.noul = TITLE_MARKER;
    answers(response).actionable![DEPARTMENT_MARKER] = 1;
    const error = (() => {
      try {
        parseTriageResponse(response);
      } catch (e) {
        return e as TriageParseError;
      }
      throw new Error("expected a throw");
    })();
    expect(error.message).toContain("answers.category.choice");
    for (const marker of [DESCRIPTION_MARKER, TITLE_MARKER, DEPARTMENT_MARKER, "network"]) {
      expect(error.message).not.toContain(marker);
    }
  });

  it("rejects a missing usage or model", () => {
    const response: Record<string, unknown> = validResponse();
    delete response.usage;
    delete response.model;
    expect(() => parseTriageResponse(response)).toThrow(TriageParseError);
  });
});
