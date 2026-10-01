import { describe, expect, it, vi } from "vitest";
import {
  SENSITIVE_TOPICS,
  classifySensitive,
  type SensitiveChecker,
  type TopicScores,
} from "./sensitive.js";

function scores(value: number, overrides: Partial<TopicScores> = {}): TopicScores {
  const all = Object.fromEntries(SENSITIVE_TOPICS.map((t) => [t, value])) as TopicScores;
  return { ...all, ...overrides };
}

function fakeChecker(result: TopicScores): SensitiveChecker {
  return { check: vi.fn(async () => ({ scores: result, checker: "fake:1" })) };
}

describe("classifySensitive", () => {
  it("is not sensitive when no keyword hits and every score is below the threshold", async () => {
    const result = await classifySensitive(
      { title: "Laptop", description: "call [REDACTED_PHONE] about my laptop" },
      fakeChecker(scores(0.1)),
      0.5,
    );
    expect(result).toEqual({ sensitive: false, flags: [], checker: "keywords+fake:1" });
  });

  it("flags a keyword hit even when the model scores 0", async () => {
    const result = await classifySensitive(
      { title: "Files", description: "I am being terminated tomorrow, need my files" },
      fakeChecker(scores(0)),
      0.5,
    );
    expect(result.sensitive).toBe(true);
    expect(result.flags).toEqual(["termination"]);
  });

  it("flags a topic whose score reaches the threshold", async () => {
    const result = await classifySensitive(
      { title: "Odd email", description: "an email asked me to confirm my login" },
      fakeChecker(scores(0.1, { security_incident: 0.8 })),
      0.5,
    );
    expect(result).toEqual({
      sensitive: true,
      flags: ["security_incident"],
      checker: "keywords+fake:1",
    });
  });

  it("treats a score equal to the threshold as flagged", async () => {
    const result = await classifySensitive(
      { title: "t", description: "d" },
      fakeChecker(scores(0.1, { legal: 0.5 })),
      0.5,
    );
    expect(result.flags).toEqual(["legal"]);
  });

  it("merges keyword and model flags without duplicates, in topic order", async () => {
    const result = await classifySensitive(
      { title: "CEO", description: "phishing" },
      fakeChecker(scores(0, { security_incident: 0.9, hr: 0.7 })),
      0.5,
    );
    expect(result.flags).toEqual(["hr", "executive", "security_incident"]);
  });

  it("checks keywords in the title as well as the description", async () => {
    const result = await classifySensitive(
      { title: "Lawsuit paperwork", description: "please restore the folder" },
      fakeChecker(scores(0)),
      0.5,
    );
    expect(result.flags).toEqual(["legal"]);
  });

  it("passes exactly the given title and description to the checker", async () => {
    const checker = fakeChecker(scores(0));
    await classifySensitive({ title: "T", description: "D" }, checker, 0.5);
    expect(checker.check).toHaveBeenCalledWith({ title: "T", description: "D" });
  });

  it("propagates a checker failure", async () => {
    const checker: SensitiveChecker = {
      check: async () => {
        throw new Error("typesafe down");
      },
    };
    await expect(classifySensitive({ title: "t", description: "d" }, checker, 0.5)).rejects.toThrow(
      "typesafe down",
    );
  });
});
