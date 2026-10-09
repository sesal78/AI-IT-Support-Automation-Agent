import {
  PRIORITIES,
  type PolicyReason,
  type Priority,
  type Route,
  type TriageFlag,
} from "./triage.js";

// The policy engine (plan P3-T9). Pure: no I/O, no clock, no input change.
// Decides whether a triaged ticket may take the auto route. Fails closed: any
// fired rule gives `review`, and any input that is not exactly the documented
// shape throws PolicyInputError instead of guessing.
//
// Input rules: booleans must be real booleans (`"true"` and `1` throw);
// probabilities must be finite numbers from 0 to 1 (NaN and Infinity throw;
// -0 is accepted as 0); `priority` must be one of PRIORITIES; unknown keys
// throw, so a typo cannot silently switch a rule off. All fields are checked
// before any rule runs, even for a sensitive ticket.
//
// Thresholds: injection, needsInfo and outageOrDuplicate fire at or above
// their threshold; low confidence fires strictly below TRIAGE_CONFIDENCE_MIN.
// So a threshold of 0 always fires its rule (0 for TRIAGE_CONFIDENCE_MIN
// never fires); a threshold of 1 fires only at probability 1 (1 for
// TRIAGE_CONFIDENCE_MIN fires for anything under 1).

export interface PolicyInput {
  sensitive: boolean;
  categoryProbability: number;
  priority: Priority;
  injection: number;
  needsInfo: number;
  outageOrDuplicate: number;
  ungroundedFix: boolean;
  capReached: boolean;
  llmUnavailable: boolean;
}

export interface PolicyThresholds {
  TRIAGE_CONFIDENCE_MIN: number;
  INJECTION_THRESHOLD: number;
  NEEDS_INFO_THRESHOLD: number;
  OUTAGE_THRESHOLD: number;
}

export interface PolicyDecision {
  route: Route;
  reasons: PolicyReason[];
  flags: TriageFlag[];
}

/** Thrown for any invalid input or threshold; `field` names the offender. */
export class PolicyInputError extends Error {
  readonly field: string;
  constructor(field: string, problem: string) {
    super(`Invalid policy input "${field}": ${problem}`);
    this.name = "PolicyInputError";
    this.field = field;
  }
}

const BOOLEAN_FIELDS = ["sensitive", "ungroundedFix", "capReached", "llmUnavailable"] as const;
const INPUT_FIELDS = [
  ...BOOLEAN_FIELDS,
  "categoryProbability",
  "injection",
  "needsInfo",
  "outageOrDuplicate",
  "priority",
] as const;
const THRESHOLD_FIELDS = [
  "TRIAGE_CONFIDENCE_MIN",
  "INJECTION_THRESHOLD",
  "NEEDS_INFO_THRESHOLD",
  "OUTAGE_THRESHOLD",
] as const;

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicyInputError(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, known: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) throw new PolicyInputError(key, "unknown key");
  }
}

function unitNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PolicyInputError(field, "must be a number from 0 to 1");
  }
  return value;
}

/** Decides the route for one ticket. Throws PolicyInputError on any invalid argument. */
export function decideRoute(input: PolicyInput, thresholds: PolicyThresholds): PolicyDecision {
  const t = asRecord(thresholds, "thresholds");
  rejectUnknownKeys(t, THRESHOLD_FIELDS);
  const confidenceMin = unitNumber(t, "TRIAGE_CONFIDENCE_MIN");
  const injectionAt = unitNumber(t, "INJECTION_THRESHOLD");
  const needsInfoAt = unitNumber(t, "NEEDS_INFO_THRESHOLD");
  const outageAt = unitNumber(t, "OUTAGE_THRESHOLD");

  const i = asRecord(input, "input");
  rejectUnknownKeys(i, INPUT_FIELDS);
  for (const field of BOOLEAN_FIELDS) {
    if (typeof i[field] !== "boolean") throw new PolicyInputError(field, "must be a boolean");
  }
  const categoryProbability = unitNumber(i, "categoryProbability");
  const injection = unitNumber(i, "injection");
  const needsInfo = unitNumber(i, "needsInfo");
  const outageOrDuplicate = unitNumber(i, "outageOrDuplicate");
  if (!(PRIORITIES as readonly unknown[]).includes(i["priority"])) {
    throw new PolicyInputError("priority", `must be one of ${PRIORITIES.join(", ")}`);
  }

  const reasons: PolicyReason[] = [];
  const flags: TriageFlag[] = [];
  if (i["sensitive"] === true) reasons.push("sensitive");
  if (injection >= injectionAt) {
    reasons.push("injection_suspected");
    flags.push("injection_suspected");
  }
  if (needsInfo >= needsInfoAt) {
    reasons.push("needs_info");
    flags.push("needs_info");
  }
  if (categoryProbability < confidenceMin) reasons.push("low_confidence");
  if (i["priority"] === "P1") reasons.push("p1");
  if (outageOrDuplicate >= outageAt) {
    reasons.push("outage_or_duplicate");
    flags.push("outage_or_duplicate");
  }
  if (i["ungroundedFix"] === true) {
    reasons.push("ungrounded_fix");
    flags.push("ungrounded_fix");
  }
  if (i["capReached"] === true) reasons.push("cap_reached");
  if (i["llmUnavailable"] === true) reasons.push("llm_unavailable");

  return { route: reasons.length > 0 ? "review" : "auto", reasons, flags };
}
