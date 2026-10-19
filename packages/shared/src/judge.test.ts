import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  JUDGE_STATE_MAX_CHARS,
  hasUnredactedText,
  judgeDefinitionSchema,
  judgeFileName,
  judgePayloadOf,
  judgeTextPayloadSchema,
} from "./judge.js";

const valid = {
  judgeId: "J1",
  version: 1,
  question: { type: "score", instructions: "Do the steps in `fix` work?", criteria: ["no", "yes"] },
  state: { fix: "Restart the router", n: 3, ok: true, none: null, list: [{ a: ["b"] }] },
};

function fieldErrors(body: unknown) {
  const parsed = judgeTextPayloadSchema.safeParse(body);
  expect(parsed.success).toBe(false);
  return z.flattenError(parsed.error!).fieldErrors as Record<string, string[] | undefined>;
}

function nested(depth: number): unknown {
  return depth === 0 ? "leaf" : { x: nested(depth - 1) };
}

describe("judgeTextPayloadSchema", () => {
  it("accepts a Score and a Noul question over a nested JSON state", () => {
    expect(judgeTextPayloadSchema.parse(valid)).toEqual(valid);
    const noul = { ...valid, question: { type: "noul", instructions: "Is `fix` safe?" } };
    expect(judgeTextPayloadSchema.parse(noul)).toEqual(noul);
  });

  it.each([
    [
      "a choice question",
      { question: { type: "choice", instructions: "x", criteria: { a: null } } },
    ],
    ["a Score with 1 level", { question: { ...valid.question, criteria: ["only"] } }],
    ["a Score with 11 levels", { question: { ...valid.question, criteria: Array(11).fill("l") } }],
  ])("refuses %s on `question`", (_name, change) => {
    expect(fieldErrors({ ...valid, ...change }).question).toBeDefined();
  });

  it("refuses a missing or unsafe judgeId", () => {
    expect(fieldErrors({ ...valid, judgeId: undefined }).judgeId).toBeDefined();
    expect(fieldErrors({ ...valid, judgeId: "../J1" }).judgeId).toBeDefined();
  });

  it.each([
    ["an array", ["x"]],
    ["a string", "x"],
    ["a __proto__ key", JSON.parse('{"a":{"__proto__":{"polluted":true}}}')],
    ["a constructor key", { constructor: "x" }],
    ["nesting deeper than 8", nested(9)],
    ["more than the size cap", { a: "x".repeat(JUDGE_STATE_MAX_CHARS) }],
    ["a non-JSON value", { a: new Date(0) }],
  ])("refuses a state that is %s", (_name, state) => {
    expect(fieldErrors({ ...valid, state }).state).toBeDefined();
  });

  it("accepts nesting of exactly 8", () => {
    expect(judgeTextPayloadSchema.safeParse({ ...valid, state: nested(8) }).success).toBe(true);
  });

  it("refuses unknown top-level keys", () => {
    expect(judgeTextPayloadSchema.safeParse({ ...valid, ticketId: "x" }).success).toBe(false);
  });

  it("never echoes a state value in an issue message", () => {
    const parsed = judgeTextPayloadSchema.safeParse({
      ...valid,
      state: { a: { constructor: "SECRETVAL" } },
    });
    expect(JSON.stringify(parsed.error)).not.toContain("SECRETVAL");
  });
});

describe("hasUnredactedText", () => {
  it("is false for redacted text, numbers, booleans and null", () => {
    expect(hasUnredactedText(valid as never)).toBe(false);
  });

  it("is false for a realistic clean judge state", () => {
    const state = {
      ticket: {
        title: "Printer offline",
        description: "The office printer shows offline since Monday, on floor 3.",
      },
      fixSteps: [
        "Turn the printer off and on again.",
        "Check the cable is plugged in.",
        "Ask IT if it stays offline after 2 tries.",
      ],
      label: "hardware",
      attempts: 2,
    };
    expect(hasUnredactedText({ question: valid.question as never, state })).toBe(false);
  });

  it.each([
    ["a deep email", { a: [{ b: [["jo@example.com"]] }] }],
    ["a phone number", { a: "call 0412 345 678" }],
    ["a card typed as a number", { a: [4111111111111111] }],
    ["an email key", { "jo@example.com": 1 }],
    ["an email split across fields", { a: "jane@", b: "example.com" }],
    ["a phone split across numbers", { n: [415, 555, 1234] }],
    ["a phone split across strings", { x: "call 415", y: "555 1234" }],
  ])("is true for %s", (_name, state) => {
    expect(hasUnredactedText({ question: valid.question as never, state })).toBe(true);
  });
});

describe("judgeDefinitionSchema", () => {
  const score = {
    id: "J1",
    version: 1,
    type: "score",
    instructions: "Grade it.",
    criteria: ["a", "b"],
  };
  const noul = {
    id: "J2",
    version: 1,
    type: "noul",
    instructions: "Is it so?",
    criteria: { true: "yes", false: "no" },
  };

  it("accepts a Score and a Noul definition", () => {
    expect(judgeDefinitionSchema.parse(score)).toEqual(score);
    expect(judgeDefinitionSchema.parse(noul)).toEqual(noul);
  });

  it.each([
    ["no id", { ...score, id: undefined }],
    ["an unsafe id", { ...score, id: "../J1" }],
    ["version 0", { ...score, version: 0 }],
    ["a choice type", { ...score, type: "choice" }],
    ["1 level", { ...score, criteria: ["a"] }],
    ["11 levels", { ...score, criteria: Array(11).fill("l") }],
    ["an extra key", { ...noul, extra: 1 }],
  ])("refuses %s", (_name, body) => {
    expect(judgeDefinitionSchema.safeParse(body).success).toBe(false);
  });

  it("names the file <id>.v<version>.json", () => {
    expect(judgeFileName(score as never)).toBe("J1.v1.json");
  });

  it("builds an endpoint body the payload schema accepts, with the question unchanged", () => {
    for (const definition of [score, noul]) {
      const body = judgePayloadOf(judgeDefinitionSchema.parse(definition), { x: "y" });
      const { id, version, ...question } = definition;
      expect(body).toEqual({ judgeId: id, version, question, state: { x: "y" } });
      expect(judgeTextPayloadSchema.safeParse(body).success).toBe(true);
    }
  });
});
