import { MAX_NOTE_LENGTH } from "@ai-it-support/helpdesk";
import { describe, expect, it } from "vitest";
import { buildSyncNote } from "./sync-note.js";

const base = {
  ticketNumber: "ITS-000042",
  category: "network",
  priority: "P2",
  assignmentGroup: "Network Support",
  kbSlugs: ["vpn-troubleshooting", "wifi-reset"],
  fixSteps: {
    steps: ["Restart the VPN client", "Reboot the router"],
    caveats: ["Needs admin rights"],
  },
};

describe("buildSyncNote", () => {
  it("lists the fixed wording, the triage fields, the KB slugs and the fix steps", () => {
    expect(buildSyncNote(base)).toBe(
      [
        "AI IT Support triage for ticket ITS-000042",
        "Category: network",
        "Priority: P2",
        "Assignment group: Network Support",
        "KB articles: vpn-troubleshooting, wifi-reset",
        "Suggested fix steps:",
        "1. Restart the VPN client",
        "2. Reboot the router",
        "Caveats:",
        "- Needs admin rights",
      ].join("\n"),
    );
  });

  it("says none for a missing group, no KB articles and no drafted fix", () => {
    const note = buildSyncNote({ ...base, assignmentGroup: null, kbSlugs: [], fixSteps: null });
    expect(note).toContain("Assignment group: none");
    expect(note).toContain("KB articles: none");
    expect(note).toContain("Suggested fix steps: none drafted");
    expect(note).not.toContain("Caveats");
  });

  it("leaves out the caveats block when there are no caveats", () => {
    const note = buildSyncNote({ ...base, fixSteps: { steps: ["Do it"], caveats: [] } });
    expect(note).toContain("1. Do it");
    expect(note).not.toContain("Caveats");
  });

  it("redacts the whole note once more before it leaves", () => {
    const note = buildSyncNote({
      ...base,
      fixSteps: { steps: ["Mail jo.bloggs@example.com", "Call 0412 345 678"], caveats: [] },
    });
    expect(note).not.toContain("jo.bloggs@example.com");
    expect(note).not.toContain("0412 345 678");
    expect(note).toContain("[REDACTED_EMAIL]");
    expect(note).toContain("ITS-000042");
  });

  it("cuts a long note to the connector limit and marks the cut", () => {
    const steps = Array.from({ length: 400 }, (_, i) => `Step number ${i} with some words`);
    const note = buildSyncNote({ ...base, fixSteps: { steps, caveats: [] } });
    expect(note.length).toBeLessThanOrEqual(MAX_NOTE_LENGTH);
    expect(note.endsWith("\n[cut]")).toBe(true);
    expect(note.startsWith("AI IT Support triage for ticket ITS-000042")).toBe(true);
  });

  it("does not cut a note that fits exactly", () => {
    const filler = "x".repeat(MAX_NOTE_LENGTH);
    const full = buildSyncNote({ ...base, kbSlugs: [], fixSteps: null });
    const pad = MAX_NOTE_LENGTH - full.length;
    const note = buildSyncNote({
      ...base,
      kbSlugs: [],
      fixSteps: null,
      assignmentGroup: filler.slice(0, pad + "Network Support".length),
    });
    expect(note.length).toBe(MAX_NOTE_LENGTH);
    expect(note).not.toContain("[cut]");
  });
});
