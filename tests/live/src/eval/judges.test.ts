import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  hasUnredactedText,
  judgeDefinitionSchema,
  judgeFileName,
  judgeTextPayloadSchema,
  redact,
  type JudgeDefinition,
} from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";
import { parseCalibrationSet } from "./calibrate.ts";

const dir = fileURLToPath(new URL("../../../../evals/judges/", import.meta.url));
const read = (path: string): unknown => JSON.parse(readFileSync(`${dir}${path}`, "utf8"));
const judges = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("judge definition files", () => {
  it("are J1 to J4, version 1", () => {
    expect(judges.sort()).toEqual(["J1.v1.json", "J2.v1.json", "J3.v1.json", "J4.v1.json"]);
  });

  it.each(judges)("%s passes judgeDefinitionSchema and is named after its id and version", (f) => {
    const definition = judgeDefinitionSchema.parse(read(f));
    expect(definition.version).toBe(1);
    expect(judgeFileName(definition)).toBe(f);
  });

  it.each([
    ["J1", "score"],
    ["J4", "score"],
    ["J2", "noul"],
    ["J3", "noul"],
  ])("%s is a %s judge, with 2 to 10 levels when it scores", (id, type) => {
    const definition = judgeDefinitionSchema.parse(read(`${id}.v1.json`));
    expect(definition.type).toBe(type);
    if (definition.type === "score") {
      expect(definition.criteria.length).toBeGreaterThanOrEqual(2);
      expect(definition.criteria.length).toBeLessThanOrEqual(10);
    }
  });

  it.each(judges)("%s is accepted by the endpoint's body schema and is not redacted", (f) => {
    const { id, version, ...question } = judgeDefinitionSchema.parse(read(f));
    expect(
      judgeTextPayloadSchema.safeParse({ judgeId: id, version, question, state: { a: "b" } })
        .success,
    ).toBe(true);
    expect(hasUnredactedText({ question, state: {} })).toBe(false);
  });
});

describe("calibration sets", () => {
  it.each([
    ["J1", "good"],
    ["J2", "follows_orders"],
  ] as const)("%s has 10 cases, at least 3 of each label, none changed by redact()", (id, key) => {
    const raw = read(`calibration/${id}.json`) as Array<Record<string, unknown>>;
    expect(raw).toHaveLength(10);
    const labels = raw.map((c) => c[key]);
    expect(labels.filter((l) => l === true).length).toBeGreaterThanOrEqual(3);
    expect(labels.filter((l) => l === false).length).toBeGreaterThanOrEqual(3);

    const cases = parseCalibrationSet(id, raw);
    for (const c of cases) {
      expect(
        hasUnredactedText({ question: { type: "noul", instructions: "x" }, state: c.state }),
      ).toBe(false);
    }
    // The check above covers every string; this one names the exact text rule.
    const texts = JSON.stringify(raw).match(/"((?:[^"\\]|\\.)*)"/g) ?? [];
    for (const t of texts) {
      const text = JSON.parse(t) as string;
      expect(redact(text).text).toBe(text);
    }
  });

  it("states use the shape the judge instructions describe", () => {
    const definitions: JudgeDefinition[] = ["J1", "J2"].map((id) =>
      judgeDefinitionSchema.parse(read(`${id}.v1.json`)),
    );
    for (const d of definitions) {
      expect(d.instructions).toContain("`ticket`");
      expect(d.instructions).toContain("`fixSteps`");
    }
    for (const id of ["J1", "J2"] as const) {
      for (const c of parseCalibrationSet(id, read(`calibration/${id}.json`))) {
        expect(Object.keys(c.state).sort()).toEqual(["fixSteps", "ticket"]);
      }
    }
  });
});
