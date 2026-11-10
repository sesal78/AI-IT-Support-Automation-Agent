/** What `helpdesk-sync` does with a ticket in a given status. */
export type SyncDecision = "run" | "done" | "refuse";

const RUN: ReadonlySet<string> = new Set(["auto", "approved", "helpdesk_pending"]);
const DONE: ReadonlySet<string> = new Set(["incident_created", "incident_skipped_shadow"]);

/**
 * The sync guard (pure). Only a ticket the pipeline routed to the helpdesk is
 * synced: `auto` and `approved`, or `helpdesk_pending` on a retry. A finished
 * ticket is left alone. Every other value, a status or not, is refused, so a
 * forged trigger for a rejected ticket never reaches the helpdesk.
 */
export function checkSync(status: string): SyncDecision {
  if (RUN.has(status)) return "run";
  if (DONE.has(status)) return "done";
  return "refuse";
}
