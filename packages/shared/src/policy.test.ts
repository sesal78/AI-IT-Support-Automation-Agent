import { describe, expect, it } from "vitest";
import { parseEnv, policyEnvShape } from "./env.js";
import {
  decideRoute,
  PolicyInputError,
  type PolicyInput,
  type PolicyThresholds,
} from "./policy.js";

const thresholds: PolicyThresholds = {
  TRIAGE_CONFIDENCE_MIN: 0.7,
  INJECTION_THRESHOLD: 0.5,
  NEEDS_INFO_THRESHOLD: 0.5,
  OUTAGE_THRESHOLD: 0.5,
};

const clean: PolicyInput = {
  sensitive: false,
  categoryProbability: 0.9,
  priority: "P3",
  injection: 0.1,
  needsInfo: 0.1,
  outageOrDuplicate: 0.1,
  ungroundedFix: false,
  capReached: false,
  llmUnavailable: false,
};

const decide = (patch: Record<string, unknown> = {}, t: unknown = thresholds) =>
  decideRoute({ ...clean, ...patch } as PolicyInput, t as PolicyThresholds);

describe("decideRoute rules", () => {
  it("routes a clean input to auto with empty lists", () => {
    expect(decide()).toEqual({ route: "auto", reasons: [], flags: [] });
  });

  it.each([
    ["sensitive", { sensitive: true }, []],
    ["injection_suspected", { injection: 0.9 }, ["injection_suspected"]],
    ["needs_info", { needsInfo: 0.9 }, ["needs_info"]],
    ["low_confidence", { categoryProbability: 0.1 }, []],
    ["p1", { priority: "P1" }, []],
    ["outage_or_duplicate", { outageOrDuplicate: 0.9 }, ["outage_or_duplicate"]],
    ["ungrounded_fix", { ungroundedFix: true }, ["ungrounded_fix"]],
    ["cap_reached", { capReached: true }, []],
    ["llm_unavailable", { llmUnavailable: true }, []],
  ])("fires %s alone", (reason, patch, flags) => {
    expect(decide(patch)).toEqual({ route: "review", reasons: [reason], flags });
  });

  it("lists reasons and flags in rule order", () => {
    expect(decide({ sensitive: true, injection: 0.9, priority: "P1" })).toEqual({
      route: "review",
      reasons: ["sensitive", "injection_suspected", "p1"],
      flags: ["injection_suspected"],
    });
    const all = decide({
      sensitive: true,
      injection: 1,
      needsInfo: 1,
      categoryProbability: 0,
      priority: "P1",
      outageOrDuplicate: 1,
      ungroundedFix: true,
      capReached: true,
      llmUnavailable: true,
    });
    expect(all.reasons).toEqual([
      "sensitive",
      "injection_suspected",
      "needs_info",
      "low_confidence",
      "p1",
      "outage_or_duplicate",
      "ungrounded_fix",
      "cap_reached",
      "llm_unavailable",
    ]);
    expect(all.flags).toEqual([
      "injection_suspected",
      "needs_info",
      "outage_or_duplicate",
      "ungrounded_fix",
    ]);
  });

  it("keeps sensitive first and the route review for all 256 combinations of the other rules", () => {
    for (let mask = 0; mask < 256; mask += 1) {
      const bit = (n: number) => (mask >> n) % 2 === 1;
      const result = decide({
        sensitive: true,
        injection: bit(0) ? 0.9 : 0.1,
        needsInfo: bit(1) ? 0.9 : 0.1,
        categoryProbability: bit(2) ? 0.1 : 0.9,
        priority: bit(3) ? "P1" : "P3",
        outageOrDuplicate: bit(4) ? 0.9 : 0.1,
        ungroundedFix: bit(5),
        capReached: bit(6),
        llmUnavailable: bit(7),
      });
      expect(result.route).toBe("review");
      expect(result.reasons[0]).toBe("sensitive");
      expect(result.reasons).toHaveLength(1 + [0, 1, 2, 3, 4, 5, 6, 7].filter(bit).length);
    }
  });

  it("does not fire p1 for other priorities", () => {
    for (const priority of ["P2", "P3", "P4"]) expect(decide({ priority }).route).toBe("auto");
  });
});

describe("decideRoute boundaries", () => {
  it("categoryProbability equal to the minimum is auto; just below is review", () => {
    expect(decide({ categoryProbability: 0.7 }).route).toBe("auto");
    expect(decide({ categoryProbability: 0.6999 })).toMatchObject({
      route: "review",
      reasons: ["low_confidence"],
    });
  });

  it.each([
    ["injection", "injection_suspected"],
    ["needsInfo", "needs_info"],
    ["outageOrDuplicate", "outage_or_duplicate"],
  ])("%s fires at exactly the threshold and not just below", (field, reason) => {
    expect(decide({ [field]: 0.5 })).toMatchObject({ route: "review", reasons: [reason] });
    expect(decide({ [field]: 0.4999 })).toEqual({ route: "auto", reasons: [], flags: [] });
  });

  it("uses each threshold for its own rule", () => {
    const t = {
      TRIAGE_CONFIDENCE_MIN: 0.2,
      INJECTION_THRESHOLD: 0.3,
      NEEDS_INFO_THRESHOLD: 0.4,
      OUTAGE_THRESHOLD: 0.6,
    };
    const low = { injection: 0.29, needsInfo: 0.39, outageOrDuplicate: 0.59 };
    expect(decide({ ...low, injection: 0.3 }, t).reasons).toEqual(["injection_suspected"]);
    expect(decide({ ...low, needsInfo: 0.4 }, t).reasons).toEqual(["needs_info"]);
    expect(decide({ ...low, outageOrDuplicate: 0.6 }, t).reasons).toEqual(["outage_or_duplicate"]);
    expect(decide({ ...low, categoryProbability: 0.2 }, t).route).toBe("auto");
    expect(decide({ ...low, categoryProbability: 0.19 }, t).reasons).toEqual(["low_confidence"]);
  });

  it("a threshold of 0 always fires its rule; 1 fires only at probability 1", () => {
    expect(decide({ injection: 0 }, { ...thresholds, INJECTION_THRESHOLD: 0 }).reasons).toEqual([
      "injection_suspected",
    ]);
    const one = { ...thresholds, INJECTION_THRESHOLD: 1 };
    expect(decide({ injection: 0.9999 }, one).route).toBe("auto");
    expect(decide({ injection: 1 }, one).route).toBe("review");
  });

  it("a minimum confidence of 0 never fires low_confidence; 1 fires below 1", () => {
    const zero = { ...thresholds, TRIAGE_CONFIDENCE_MIN: 0 };
    expect(decide({ categoryProbability: 0 }, zero).route).toBe("auto");
    const one = { ...thresholds, TRIAGE_CONFIDENCE_MIN: 1 };
    expect(decide({ categoryProbability: 0.9999 }, one).reasons).toEqual(["low_confidence"]);
    expect(decide({ categoryProbability: 1 }, one).route).toBe("auto");
  });

  it("accepts 0, 1 and -0 as probabilities", () => {
    for (const value of [0, 1, -0]) {
      expect(() =>
        decide({ injection: value, needsInfo: value, outageOrDuplicate: value }),
      ).not.toThrow();
    }
  });
});

describe("decideRoute input validation", () => {
  const probabilityFields = ["categoryProbability", "injection", "needsInfo", "outageOrDuplicate"];

  it.each(probabilityFields)("rejects bad values for %s, naming the field", (field) => {
    for (const bad of [Number.NaN, -0.1, 1.1, Infinity, -Infinity, "0.5", null, undefined]) {
      expect(() => decide({ [field]: bad }), `${field}=${String(bad)}`).toThrow(PolicyInputError);
      expect(() => decide({ [field]: bad })).toThrow(new RegExp(field));
    }
  });

  it.each(probabilityFields)("rejects a missing %s", (field) => {
    const rest: Record<string, unknown> = { ...clean };
    delete rest[field];
    expect(() => decideRoute(rest as unknown as PolicyInput, thresholds)).toThrow(
      new RegExp(field),
    );
  });

  it.each(["sensitive", "ungroundedFix", "capReached", "llmUnavailable"])(
    "rejects a non-boolean %s",
    (field) => {
      for (const bad of ["true", "false", 1, 0, null, undefined]) {
        expect(() => decide({ [field]: bad })).toThrow(PolicyInputError);
        expect(() => decide({ [field]: bad })).toThrow(new RegExp(field));
      }
    },
  );

  it("rejects an unknown or missing priority", () => {
    expect(() => decide({ priority: "P5" })).toThrow(/priority/);
    expect(() => decide({ priority: "p1" })).toThrow(PolicyInputError);
    expect(() => decide({ priority: undefined })).toThrow(/priority/);
  });

  it("rejects unknown input keys, naming them", () => {
    expect(() => decide({ sensitve: true })).toThrow(/sensitve/);
  });

  it("rejects a non-object input", () => {
    for (const bad of [null, undefined, "x", 1, []]) {
      expect(() => decideRoute(bad as never, thresholds)).toThrow(PolicyInputError);
    }
  });

  it.each(Object.keys(thresholds))("rejects a bad threshold %s, naming it", (key) => {
    for (const bad of [-0.1, 1.1, Number.NaN, Infinity, "0.5", undefined, null]) {
      expect(() => decide({}, { ...thresholds, [key]: bad })).toThrow(PolicyInputError);
      expect(() => decide({}, { ...thresholds, [key]: bad })).toThrow(new RegExp(key));
    }
  });

  it("rejects unknown threshold keys and non-object thresholds", () => {
    expect(() => decide({}, { ...thresholds, EXTRA: 0.5 })).toThrow(/EXTRA/);
    for (const bad of [null, undefined, 1, []]) {
      expect(() => decideRoute(clean, bad as never)).toThrow(PolicyInputError);
    }
  });

  it("names the field on the error and has the right name", () => {
    try {
      decide({ injection: 2 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyInputError);
      expect((error as PolicyInputError).field).toBe("injection");
      expect((error as Error).name).toBe("PolicyInputError");
    }
  });

  it("validates even when a sensitive ticket would be review anyway", () => {
    expect(() => decide({ sensitive: true, injection: 7 })).toThrow(/injection/);
  });

  it("does not change a frozen input or thresholds, and returns fresh arrays", () => {
    const input = Object.freeze({ ...clean, sensitive: true, injection: 0.9 });
    const frozenThresholds = Object.freeze({ ...thresholds });
    const first = decideRoute(input, frozenThresholds);
    first.reasons.push("p1");
    expect(decideRoute(input, frozenThresholds).reasons).toEqual([
      "sensitive",
      "injection_suspected",
    ]);
    expect(input).toEqual({ ...clean, sensitive: true, injection: 0.9 });
  });
});

describe("decideRoute hostile objects", () => {
  const unitFields = ["categoryProbability", "injection", "needsInfo", "outageOrDuplicate"];

  it("does not take a missing field or threshold from a polluted prototype", () => {
    const proto = Object.prototype as Record<string, unknown>;
    const names = [...Object.keys(clean), ...Object.keys(thresholds)];
    try {
      for (const name of names) proto[name] = 0;
      proto["sensitive"] = false;
      proto["ungroundedFix"] = false;
      proto["capReached"] = false;
      proto["llmUnavailable"] = false;
      proto["priority"] = "P3";
      for (const key of Object.keys(clean)) {
        const rest: Record<string, unknown> = { ...clean };
        delete rest[key];
        expect(() => decideRoute(rest as unknown as PolicyInput, thresholds), key).toThrow(
          new RegExp(key),
        );
      }
      for (const key of Object.keys(thresholds)) {
        const rest: Record<string, unknown> = { ...thresholds };
        delete rest[key];
        expect(() => decideRoute(clean, rest as unknown as PolicyThresholds), key).toThrow(
          new RegExp(key),
        );
      }
    } finally {
      for (const name of names) delete proto[name];
    }
  });

  it("reads each value once, so a getter that flips cannot slip past validation", () => {
    for (const key of ["sensitive", "ungroundedFix", "capReached", "llmUnavailable"]) {
      let reads = 0;
      const input = { ...clean };
      Object.defineProperty(input, key, { enumerable: true, get: () => reads++ === 0 });
      expect(decideRoute(input, thresholds).route, key).toBe("review");
      expect(reads, key).toBe(1);
    }
    for (const key of Object.keys(thresholds)) {
      let reads = 0;
      const flipping = { ...thresholds };
      Object.defineProperty(flipping, key, {
        enumerable: true,
        get: () => (reads++ === 0 ? 0.5 : 2),
      });
      expect(() => decideRoute(clean, flipping), key).not.toThrow();
      expect(reads, key).toBe(1);
    }
    for (const key of unitFields) {
      let reads = 0;
      const input = { ...clean };
      Object.defineProperty(input, key, {
        enumerable: true,
        get: () => (reads++ === 0 ? 0.5 : 2),
      });
      expect(() => decideRoute(input, thresholds), key).not.toThrow();
      expect(reads, key).toBe(1);
    }
    let reads = 0;
    const input = { ...clean };
    Object.defineProperty(input, "priority", {
      enumerable: true,
      get: () => (reads++ === 0 ? "P1" : "P3"),
    });
    expect(decideRoute(input, thresholds).reasons).toEqual(["p1"]);
    expect(reads).toBe(1);
  });
});

describe("policyEnvShape spellings", () => {
  it.each(Object.keys(thresholds))("rejects odd number spellings for %s, naming it", (key) => {
    for (const bad of [" ", "\t", "0x1", "0b1", "1e-1", "-0", ".5", "1.5", " 0.5", "0.5 "]) {
      expect(() => parseEnv(policyEnvShape, { [key]: bad }), JSON.stringify(bad)).toThrow(
        new RegExp(key),
      );
    }
  });

  it.each(Object.keys(thresholds))("takes plain decimals and the default for %s", (key) => {
    const name = key as keyof PolicyThresholds;
    expect(parseEnv(policyEnvShape, {})[name]).toBe(thresholds[name]);
    expect(parseEnv(policyEnvShape, { [key]: "" })[name]).toBe(thresholds[name]);
    expect(parseEnv(policyEnvShape, { [key]: "0" })[name]).toBe(0);
    expect(parseEnv(policyEnvShape, { [key]: "0.25" })[name]).toBe(0.25);
    expect(parseEnv(policyEnvShape, { [key]: "1" })[name]).toBe(1);
    expect(parseEnv(policyEnvShape, { [key]: "1.0" })[name]).toBe(1);
  });
});

describe("policyEnvShape", () => {
  it("gives the four defaults", () => {
    expect(parseEnv(policyEnvShape, {})).toEqual(thresholds);
  });

  it("reads numbers from strings", () => {
    expect(parseEnv(policyEnvShape, { OUTAGE_THRESHOLD: "0.25" }).OUTAGE_THRESHOLD).toBe(0.25);
  });

  it.each(Object.keys(thresholds))("rejects bad values for %s, naming it", (key) => {
    for (const bad of ["2", "abc", "-0.1"]) {
      expect(() => parseEnv(policyEnvShape, { [key]: bad })).toThrow(new RegExp(key));
    }
  });
});
