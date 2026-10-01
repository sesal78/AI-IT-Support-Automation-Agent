import { afterEach, describe, expect, it, vi } from "vitest";
import { SENSITIVE_TOPICS } from "./sensitive.js";
import { createTypeSafeChecker } from "./typesafe-checker.js";

const FAKE_KEY = "test-typesafe-key";

function nouls(values: Record<string, number>) {
  return Object.fromEntries(Object.entries(values).map(([k, noul]) => [k, { type: "noul", noul }]));
}

const allScores = Object.fromEntries(SENSITIVE_TOPICS.map((t) => [t, 0.1]));

interface Captured {
  url: string;
  headers: Headers;
  body: {
    state: unknown;
    model?: string;
    questions: Record<string, { type: string; instructions: unknown; criteria?: unknown }>;
  };
}

/** Stubs global fetch (used by the TypeSafe SDK) with one JSON response. */
function stubFetch(status: number, body: unknown): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input instanceof Request ? input.url : input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTypeSafeChecker", () => {
  it("sends one Noul per topic with the redacted ticket as JSON state", async () => {
    const captured = stubFetch(200, {
      model: "jev-1.13.0",
      answers: nouls({ ...allScores, security_incident: 0.8 }),
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const checker = createTypeSafeChecker({ apiKey: FAKE_KEY });

    const result = await checker.check({ title: "Odd email", description: "[REDACTED_EMAIL]" });

    expect(result).toEqual({
      scores: { ...allScores, security_incident: 0.8 },
      checker: "typesafe:jev-1.13.0",
    });
    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request!.url).toMatch(/\/v1\/systemone$/);
    expect(request!.headers.get("authorization") ?? "").toContain(FAKE_KEY);
    expect(request!.body.state).toEqual({
      ticket: { title: "Odd email", description: "[REDACTED_EMAIL]" },
    });
    expect(Object.keys(request!.body.questions).sort()).toEqual([...SENSITIVE_TOPICS].sort());
    for (const question of Object.values(request!.body.questions)) {
      expect(question.type).toBe("noul");
      expect(typeof question.instructions).toBe("string");
      expect(question.instructions).toContain("`ticket`");
    }
  });

  it("throws when an answer is missing", async () => {
    const rest: Record<string, number> = { ...allScores };
    delete rest.legal;
    stubFetch(200, { model: "jev-1", answers: nouls(rest), usage: {} });
    const checker = createTypeSafeChecker({ apiKey: FAKE_KEY });
    await expect(checker.check({ title: "t", description: "d" })).rejects.toThrow(/legal/);
  });

  it("throws when a probability is out of range", async () => {
    stubFetch(200, { model: "jev-1", answers: nouls({ ...allScores, hr: 1.5 }), usage: {} });
    const checker = createTypeSafeChecker({ apiKey: FAKE_KEY });
    await expect(checker.check({ title: "t", description: "d" })).rejects.toThrow(/hr/);
  });

  it("does not echo ticket text in a shape error", async () => {
    stubFetch(200, { model: "jev-1", answers: nouls({ ...allScores, hr: -1 }), usage: {} });
    const checker = createTypeSafeChecker({ apiKey: FAKE_KEY });
    const error = await checker.check({ title: "t", description: "secret words" }).catch((e) => e);
    expect(String(error)).not.toContain("secret words");
  });

  it("propagates an API error", async () => {
    stubFetch(400, { detail: "bad request" });
    const checker = createTypeSafeChecker({ apiKey: FAKE_KEY });
    await expect(checker.check({ title: "t", description: "d" })).rejects.toThrow();
  });

  it("rejects an empty API key", () => {
    expect(() => createTypeSafeChecker({ apiKey: "" })).toThrow(/apiKey/);
  });
});
