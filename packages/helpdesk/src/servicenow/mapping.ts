import type { HelpdeskTicketState } from "../types.js";

/** The six triage categories; the ServiceNow category choice has the same values. */
const CATEGORIES = [
  "database",
  "inquiry",
  "software",
  "hardware",
  "password_reset",
  "network",
] as const;

const IMPACT_URGENCY = {
  P1: { impact: 1, urgency: 1 },
  P2: { impact: 1, urgency: 2 },
  P3: { impact: 2, urgency: 2 },
  P4: { impact: 2, urgency: 3 },
} as const;

export const CLOSE_CODE = "Closed/Resolved by Caller";
export const CLOSE_NOTES = "Closed by the AI IT Support Agent.";
const HOLD_REASON_AWAITING_CALLER = 1;

export type ServiceNowState =
  | { state: 1 | 2 }
  | { state: 3; hold_reason: 1 }
  | { state: 6 | 7; close_code: string; close_notes: string };

// Messages never repeat the offending value.
export function toServiceNowCategory(category: unknown): string {
  if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    throw new TypeError("category is not one of the supported categories");
  }
  return category as string;
}

export function toImpactUrgency(priority: unknown): { impact: number; urgency: number } {
  if (typeof priority !== "string" || !Object.hasOwn(IMPACT_URGENCY, priority)) {
    throw new TypeError("priority must be P1, P2, P3 or P4");
  }
  return { ...IMPACT_URGENCY[priority as keyof typeof IMPACT_URGENCY] };
}

export function toServiceNowState(state: HelpdeskTicketState): ServiceNowState {
  switch (state) {
    case "new":
      return { state: 1 };
    case "in_progress":
      return { state: 2 };
    case "on_hold":
      return { state: 3, hold_reason: HOLD_REASON_AWAITING_CALLER };
    case "resolved":
      return { state: 6, close_code: CLOSE_CODE, close_notes: CLOSE_NOTES };
    case "closed":
      return { state: 7, close_code: CLOSE_CODE, close_notes: CLOSE_NOTES };
    default:
      throw new TypeError("state is not a known helpdesk state");
  }
}
