// Built-in helpdesk ticket states (plan §6.3.1 G3). Pure: no I/O, no stored state.
// Migration 0007 seeds the same pairs into helpdesk_state_transitions; a parity
// test (P5-T11c) keeps the two equal.

/** The 5 helpdesk states. Frozen, so a run-time write throws instead of changing the rules. */
export const HELPDESK_STATES = Object.freeze([
  "new",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
] as const);

export type HelpdeskState = (typeof HELPDESK_STATES)[number];

/** Moves per state, in G3 order. Nothing leaves `closed`. Private: callers get copies. */
const NEXT: Record<HelpdeskState, readonly HelpdeskState[]> = {
  new: ["in_progress", "on_hold", "resolved", "closed"],
  in_progress: ["on_hold", "resolved"],
  on_hold: ["in_progress", "resolved"],
  resolved: ["closed", "in_progress"],
  closed: [],
};

/**
 * Every legal `[from, to]` pair, frozen all the way down. The order is the one
 * migration 0007 seeds. For the parity test.
 */
export const HELPDESK_STATE_TRANSITIONS: readonly (readonly [HelpdeskState, HelpdeskState])[] =
  Object.freeze(
    HELPDESK_STATES.flatMap((from) => NEXT[from].map((to) => Object.freeze([from, to] as const))),
  );

// A list lookup, not `in`: an inherited key such as "constructor" must not pass.
const isHelpdeskState = (value: unknown): value is HelpdeskState =>
  (HELPDESK_STATES as readonly unknown[]).includes(value);

/**
 * Thrown for an illegal move and for a value that is not a helpdesk state.
 * The message names known states only. An unknown value is never echoed: it
 * could be anything, including ticket text.
 */
export class IllegalHelpdeskTransitionError extends Error {
  constructor(from: unknown, to: unknown) {
    const label = (value: unknown) => (isHelpdeskState(value) ? value : "(unknown state)");
    super(`Illegal helpdesk state transition: ${label(from)} -> ${label(to)}`);
    this.name = "IllegalHelpdeskTransitionError";
  }
}

/**
 * True when a ticket may move from `from` to `to`. A same-state pair is false.
 * Throws IllegalHelpdeskTransitionError when either value is not a helpdesk
 * state, so bad input never reads as a plain "no".
 */
export function canHelpdeskTransition(from: HelpdeskState, to: HelpdeskState): boolean {
  if (!isHelpdeskState(from) || !isHelpdeskState(to)) {
    throw new IllegalHelpdeskTransitionError(from, to);
  }
  return NEXT[from].includes(to);
}

/** Throws IllegalHelpdeskTransitionError unless `from` → `to` is a legal move. */
export function assertHelpdeskTransition(from: HelpdeskState, to: HelpdeskState): void {
  if (!canHelpdeskTransition(from, to)) throw new IllegalHelpdeskTransitionError(from, to);
}

/**
 * The states reachable from `from`, in G3 order. A new list on every call, so
 * a caller cannot change the rules. Throws IllegalHelpdeskTransitionError for
 * a value that is not a helpdesk state.
 */
export function nextHelpdeskStates(from: HelpdeskState): HelpdeskState[] {
  if (!isHelpdeskState(from)) throw new IllegalHelpdeskTransitionError(from, undefined);
  return [...NEXT[from]];
}
