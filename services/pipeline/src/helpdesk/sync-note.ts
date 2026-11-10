import { MAX_NOTE_LENGTH } from "@ai-it-support/helpdesk";
import { redact } from "@ai-it-support/shared";

export interface SyncNoteInput {
  ticketNumber: string;
  category: string;
  priority: string;
  assignmentGroup: string | null;
  kbSlugs: readonly string[];
  fixSteps: { steps: readonly string[]; caveats: readonly string[] } | null;
}

const CUT = "\n[cut]";

/**
 * The work note `helpdesk-sync` adds after it creates the incident (resolved
 * point 6): fixed wording plus the triage fields, KB slugs and fix steps. The
 * whole text passes `redact` once more and is cut to the connector's note limit.
 */
export function buildSyncNote(input: SyncNoteInput): string {
  const lines = [
    `AI IT Support triage for ticket ${input.ticketNumber}`,
    `Category: ${input.category}`,
    `Priority: ${input.priority}`,
    `Assignment group: ${input.assignmentGroup ?? "none"}`,
    `KB articles: ${input.kbSlugs.length === 0 ? "none" : input.kbSlugs.join(", ")}`,
  ];
  if (input.fixSteps === null) {
    lines.push("Suggested fix steps: none drafted");
  } else {
    lines.push("Suggested fix steps:");
    input.fixSteps.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    if (input.fixSteps.caveats.length > 0) {
      lines.push("Caveats:", ...input.fixSteps.caveats.map((caveat) => `- ${caveat}`));
    }
  }
  const text = redact(lines.join("\n")).text;
  return text.length <= MAX_NOTE_LENGTH ? text : text.slice(0, MAX_NOTE_LENGTH - CUT.length) + CUT;
}
