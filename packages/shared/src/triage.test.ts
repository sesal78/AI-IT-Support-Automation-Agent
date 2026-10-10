import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_GROUPS,
  CATEGORIES,
  DEFAULT_GROUP_FOR_CATEGORY,
  PRIORITIES,
  ROUTES,
  SECURITY_INCIDENT_GROUP,
  TRIAGE_FLAGS,
  triageResultSchema,
  URGENCIES,
} from "./triage.js";

const KB_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const KB_B = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const KB_C = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const KB_D = "9b2f1c3a-5d4e-4f60-8a7b-1c2d3e4f5a6b";

const valid = {
  category: "software",
  subcategory: "email",
  priority: "P3",
  urgency: "medium",
  assignmentGroup: "Software",
  route: "auto",
  probabilities: { software: 0.8, network: 0.2 },
  flags: ["needs_info"],
  groundingScore: 0.9,
  kbArticleIds: [KB_A, KB_B],
  suggestedFix: { steps: ["Restart the client"] },
  modelVersions: { typesafe: "jev-1", llm: "m-1" },
};

/** Top-level field names the schema complains about. */
function fields(input: unknown): string[] {
  const result = triageResultSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => String(issue.path[0] ?? "(root)"));
}

describe("constants (hand-written oracle)", () => {
  it("equal the spec lists, in order", () => {
    expect([...CATEGORIES]).toEqual([
      "database",
      "inquiry",
      "software",
      "hardware",
      "password_reset",
      "network",
    ]);
    expect([...PRIORITIES]).toEqual(["P1", "P2", "P3", "P4"]);
    expect([...URGENCIES]).toEqual(["high", "medium", "low"]);
    expect([...ROUTES]).toEqual(["auto", "review"]);
    expect([...TRIAGE_FLAGS]).toEqual([
      "injection_suspected",
      "needs_info",
      "ungrounded_fix",
      "outage_or_duplicate",
    ]);
    expect([...ASSIGNMENT_GROUPS]).toEqual([
      "Service Desk",
      "Hardware",
      "Software",
      "Network",
      "Database",
      "IT Securities",
    ]);
  });

  it("maps each category to its default group", () => {
    expect(DEFAULT_GROUP_FOR_CATEGORY).toEqual({
      database: "Database",
      hardware: "Hardware",
      software: "Software",
      network: "Network",
      password_reset: "Service Desk",
      inquiry: "Service Desk",
    });
    for (const group of Object.values(DEFAULT_GROUP_FOR_CATEGORY)) {
      expect(ASSIGNMENT_GROUPS).toContain(group);
    }
    expect(SECURITY_INCIDENT_GROUP).toBe("IT Securities");
  });
});

describe("triageResultSchema", () => {
  it("accepts a full valid result", () => {
    expect(triageResultSchema.parse(valid)).toEqual(valid);
  });

  it("accepts empty lists and a null fix", () => {
    const result = { ...valid, kbArticleIds: [], flags: [], suggestedFix: null };
    expect(triageResultSchema.parse(result)).toEqual(result);
  });

  it("accepts a null subcategory and a null grounding score", () => {
    const result = { ...valid, subcategory: null, groundingScore: null };
    expect(triageResultSchema.safeParse(result).success).toBe(true);
  });

  it("accepts exactly 3 KB articles and the score bounds 0 and 1", () => {
    expect(
      triageResultSchema.safeParse({ ...valid, kbArticleIds: [KB_A, KB_B, KB_C] }).success,
    ).toBe(true);
    expect(triageResultSchema.safeParse({ ...valid, groundingScore: 0 }).success).toBe(true);
    expect(triageResultSchema.safeParse({ ...valid, groundingScore: 1 }).success).toBe(true);
  });

  it.each([
    ["category", { category: "printer" }],
    ["category", { category: "" }],
    ["priority", { priority: "P5" }],
    ["urgency", { urgency: "critical" }],
    ["route", { route: "maybe" }],
    ["assignmentGroup", { assignmentGroup: "Marketing" }],
    ["assignmentGroup", { assignmentGroup: "it securities" }],
    ["groundingScore", { groundingScore: 1.2 }],
    ["groundingScore", { groundingScore: -0.1 }],
    ["groundingScore", { groundingScore: Number.NaN }],
    ["groundingScore", { groundingScore: Number.POSITIVE_INFINITY }],
    ["flags", { flags: ["bogus"] }],
    ["flags", { flags: ["needs_info", "needs_info"] }],
    ["kbArticleIds", { kbArticleIds: ["not-a-uuid"] }],
    ["kbArticleIds", { kbArticleIds: [KB_A, KB_B, KB_C, KB_D] }],
    ["kbArticleIds", { kbArticleIds: [KB_A, KB_A] }],
    ["kbArticleIds", { kbArticleIds: [KB_A, KB_A.toUpperCase()] }],
    ["probabilities", { probabilities: { software: 1.5 } }],
  ])("rejects, naming %s: %j", (field, patch) => {
    expect(fields({ ...valid, ...patch })).toContain(field);
  });

  it.each(Object.keys(valid))("rejects a missing %s (missing is not null)", (key) => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest[key];
    expect(fields(rest)).toContain(key);
  });

  it.each(["route", "probabilities", "flags", "kbArticleIds", "modelVersions"])(
    "rejects a null %s",
    (key) => {
      expect(fields({ ...valid, [key]: null })).toContain(key);
    },
  );

  // The TypeSafe cap leaves the judged fields null (P3-T10c); such a result must route review.
  it.each(["category", "priority", "urgency", "assignmentGroup"])(
    "accepts a null %s only with the route review",
    (key) => {
      expect(triageResultSchema.safeParse({ ...valid, [key]: null, route: "review" }).success).toBe(
        true,
      );
      expect(fields({ ...valid, [key]: null, route: "auto" })).toEqual(["route"]);
    },
  );

  it("accepts the TypeSafe-cap result: no judgments, no KB, no fix, route review", () => {
    const capped = {
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
    };
    expect(triageResultSchema.parse(capped)).toEqual(capped);
    expect(fields({ ...capped, route: "auto" })).toEqual(["route"]);
  });

  it("lowercases upper-case UUIDs", () => {
    const parsed = triageResultSchema.parse({ ...valid, kbArticleIds: [KB_A.toUpperCase()] });
    expect(parsed.kbArticleIds).toEqual([KB_A]);
  });

  it("rejects unknown keys instead of stripping them", () => {
    expect(triageResultSchema.safeParse({ ...valid, sensitive: true }).success).toBe(false);
  });

  it("rejects an own __proto__ key and leaves Object.prototype alone", () => {
    const json = JSON.stringify(valid).slice(0, -1) + ',"__proto__":{"polluted":true}}';
    expect(triageResultSchema.safeParse(JSON.parse(json)).success).toBe(false);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("does not pollute prototypes through a __proto__ key in a nested record", () => {
    const probabilities = JSON.parse('{"__proto__": 0.5}') as Record<string, number>;
    triageResultSchema.safeParse({ ...valid, probabilities });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});
