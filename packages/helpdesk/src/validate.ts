import { UPDATE_STATES, type HelpdeskUpdateState } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_NOTE_LENGTH = 5000;

// Messages never repeat the offending value.
export function assertTicketId(ticketId: unknown): asserts ticketId is string {
  if (typeof ticketId !== "string" || !UUID.test(ticketId)) {
    throw new TypeError("ticketId must be a UUID");
  }
}

export function assertNoteBody(body: unknown): asserts body is string {
  if (typeof body !== "string" || body.length < 1 || body.length > MAX_NOTE_LENGTH) {
    throw new TypeError(`note body must be 1-${MAX_NOTE_LENGTH} characters`);
  }
}

export function assertUpdateState(state: unknown): asserts state is HelpdeskUpdateState {
  if (!UPDATE_STATES.includes(state as HelpdeskUpdateState)) {
    throw new TypeError("state is not an allowed update state");
  }
}
