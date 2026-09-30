/** What the ticket form shows after `POST /api/tickets` answers. */
export type SubmitOutcome =
  | { kind: "success"; ticketId: string }
  | { kind: "invalid"; fieldErrors: Record<string, string>; message: string }
  | { kind: "retry"; message: string }
  | { kind: "error"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const GENERIC_ERROR = "We could not send your ticket. Please try again in a moment.";

/** Maps a status and JSON body from the P2-T4 route to a form outcome. */
export function interpretSubmitResponse(status: number, body: unknown): SubmitOutcome {
  const data = isRecord(body) ? body : {};

  if (status === 201 && typeof data.ticketId === "string" && data.ticketId !== "") {
    return { kind: "success", ticketId: data.ticketId };
  }
  if (status === 400) {
    const fieldErrors: Record<string, string> = {};
    if (isRecord(data.fieldErrors)) {
      for (const [field, messages] of Object.entries(data.fieldErrors)) {
        if (Array.isArray(messages) && typeof messages[0] === "string") {
          fieldErrors[field] = messages[0];
        }
      }
    }
    return {
      kind: "invalid",
      fieldErrors,
      message: "Some details need fixing. Check the highlighted fields and submit again.",
    };
  }
  if (status === 403) {
    return {
      kind: "retry",
      message: "The security check did not pass. Complete it again, then resubmit your ticket.",
    };
  }
  if (status === 429) {
    return {
      kind: "retry",
      message: "Too many requests from your network. Wait about 10 minutes, then try again.",
    };
  }
  return { kind: "error", message: GENERIC_ERROR };
}
