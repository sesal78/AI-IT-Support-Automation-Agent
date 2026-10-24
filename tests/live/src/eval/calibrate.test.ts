import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { markerEnv } from "../testing/env.ts";
import { startMockE2e, type MockE2e } from "../testing/mock-e2e.ts";
import { mockJudgments, type MockJudgment } from "../testing/mock-judgments.ts";
import { runCalibrate } from "./calibrate.ts";

const judgesDir = fileURLToPath(new URL("../../../../evals/judges", import.meta.url));
const labels = (file: string, key: string): boolean[] =>
  (
    JSON.parse(readFileSync(`${judgesDir}/calibration/${file}.json`, "utf8")) as Array<
      Record<string, boolean>
    >
  ).map((c) => c[key]!);

const mocks: MockE2e[] = [];
afterEach(async () => {
  for (const mock of mocks.splice(0)) await mock.close();
});

/** Answers so that exactly the first `agreeing` cases agree with `judge`'s labels. */
function answers(judge: "J1" | "J2", agreeing: number) {
  const isTrue = judge === "J1" ? labels("J1", "good") : labels("J2", "follows_orders");
  const high = judge === "J1" ? 0.75 : 0.9;
  const low = judge === "J1" ? 0.25 : 0.1;
  return (n: number): MockJudgment => {
    const label = isTrue[n - 1]!;
    const agrees = n <= agreeing;
    return label === agrees ? high : low;
  };
}

async function harness(outcome: (n: number, body: unknown) => MockJudgment) {
  const values = markerEnv("http://127.0.0.1:1");
  const judgments = mockJudgments(outcome);
  const mock = await startMockE2e({
    token: values.INTERNAL_API_TOKEN,
    accessClientId: values.CF_ACCESS_CLIENT_ID,
    accessClientSecret: values.CF_ACCESS_CLIENT_SECRET,
    override: judgments.override,
  });
  mocks.push(mock);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = (argv: string[], extra: { timeoutMs?: number } = {}) =>
    runCalibrate({
      argv,
      env: { ...values, E2E_BASE_URL: mock.origin },
      judgesDir,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      pollIntervalMs: 1,
      timeoutMs: 5_000,
      ...extra,
    });
  return { mock, judgments, stdout, stderr, run };
}

describe("eval:calibrate", () => {
  it("prints 8/10 and exits 0 with 8 agreeing J1 answers", async () => {
    const h = await harness(answers("J1", 8));
    expect(await h.run(["--judge", "J1"])).toBe(0);
    expect(h.stdout.at(-1)).toBe("J1 v1: 8/10");
    expect(h.stdout.filter((l) => l.endsWith("disagree"))).toHaveLength(2);
  });

  it("exits 1 with 7 agreeing J1 answers", async () => {
    const h = await harness(answers("J1", 7));
    expect(await h.run(["--judge", "J1"])).toBe(1);
    expect(h.stdout.at(-1)).toBe("J1 v1: 7/10");
  });

  it("calibrates J2 with a 0.5 threshold", async () => {
    const h = await harness(answers("J2", 10));
    expect(await h.run(["--judge=J2"])).toBe(0);
    expect(h.stdout.at(-1)).toBe("J2 v1: 10/10");
    const edge = await harness(() => 0.5);
    // 0.5 counts as follows_orders: it agrees with exactly the true labels.
    const trues = labels("J2", "follows_orders").filter(Boolean).length;
    expect(await edge.run(["--judge", "J2"])).toBe(trues >= 8 ? 0 : 1);
    expect(edge.stdout.at(-1)).toBe(`J2 v1: ${trues}/10`);
  });

  it("treats 0.7 as good and 0.69 as not good for J1", async () => {
    const good = labels("J1", "good");
    const at = await harness(() => 0.7);
    await at.run(["--judge", "J1"]);
    expect(at.stdout.at(-1)).toBe(`J1 v1: ${good.filter(Boolean).length}/10`);
    const below = await harness(() => 0.69);
    await below.run(["--judge", "J1"]);
    expect(below.stdout.at(-1)).toBe(`J1 v1: ${good.filter((g) => !g).length}/10`);
  });

  it("sends the definition's type, instructions and criteria unchanged with judgeId and version", async () => {
    const h = await harness(answers("J1", 10));
    await h.run(["--judge", "J1"]);
    const definition = JSON.parse(readFileSync(`${judgesDir}/J1.v1.json`, "utf8")) as Record<
      string,
      unknown
    >;
    const cases = JSON.parse(readFileSync(`${judgesDir}/calibration/J1.json`, "utf8")) as Array<{
      state: unknown;
    }>;
    expect(h.judgments.bodies).toHaveLength(10);
    expect(h.judgments.bodies[0]).toEqual({
      judgeId: "J1",
      version: 1,
      question: {
        type: definition["type"],
        instructions: definition["instructions"],
        criteria: definition["criteria"],
      },
      state: cases[0]!.state,
    });
  });

  it("lists the known judges for an unknown one, without calling the app", async () => {
    const h = await harness(() => 0.5);
    expect(await h.run(["--judge", "J9"])).toBe(2);
    expect(h.stderr.join("\n")).toContain("known: J1, J2, J3, J4");
    expect(h.mock.requests).toHaveLength(0);
  });

  it.each(["J3", "J4"])("refuses %s: only J1 and J2 have calibration sets", async (id) => {
    const h = await harness(() => 0.5);
    expect(await h.run(["--judge", id])).toBe(2);
    expect(h.stderr.join("\n")).toContain("only J1 and J2 have calibration sets");
    expect(h.mock.requests).toHaveLength(0);
  });

  it("needs --judge", async () => {
    const h = await harness(() => 0.5);
    expect(await h.run([])).toBe(2);
    expect(h.stderr.join("\n")).toContain("usage: --judge");
  });

  it("exits 2 when a judgment failed, not 1", async () => {
    const h = await harness((n) => (n === 4 ? "failed" : 0.9));
    expect(await h.run(["--judge", "J1"])).toBe(2);
    expect(h.stderr.join("\n")).toContain("case 4: judgment failed");
    expect(h.stdout.join("\n")).not.toContain("/10");
  });

  it("exits 2 when a judgment does not finish inside the limit", async () => {
    const h = await harness((n) => (n === 2 ? "pending" : 0.9));
    expect(await h.run(["--judge", "J1"], { timeoutMs: 30 })).toBe(2);
    expect(h.stderr.join("\n")).toContain("case 2: judgment timeout");
  });

  it("exits 2 on an answer in the wrong shape, naming only the class", async () => {
    const h = await harness(() => "bad_shape");
    expect(await h.run(["--judge", "J1"])).toBe(2);
    expect(h.stderr.join("\n")).toContain("case 1: request failed (LiveContractError)");
  });

  it("prints case numbers and agreement only, never case text", async () => {
    const h = await harness(answers("J2", 9));
    await h.run(["--judge", "J2"]);
    const printed = [...h.stdout, ...h.stderr].join("\n");
    expect(h.stdout.slice(0, 10).every((l) => /^case \d+: (agree|disagree)$/.test(l))).toBe(true);
    const cases = JSON.parse(readFileSync(`${judgesDir}/calibration/J2.json`, "utf8")) as Array<{
      state: { ticket: { title: string }; fixSteps: string[] };
    }>;
    for (const c of cases) {
      expect(printed).not.toContain(c.state.ticket.title);
      expect(printed).not.toContain(c.state.fixSteps[0]!);
    }
  });
});
