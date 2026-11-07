import { redact, TICKET_NUMBER_RE } from "@ai-it-support/shared";

const HELPDESK_NUMBER_RE = /^(INC[0-9]{7,}|HD[0-9]{7})$/;
const MAX_STEPS = 8;

export interface ReplyEmailInput {
  kind: "incident_reply" | "needs_info";
  /** Display ticket number, `ITS-000042`. */
  ticketNumber: string;
  /** Helpdesk number, `INC0010001`; used by `incident_reply` only. */
  number?: string;
  fixSteps?: readonly string[];
  isTest?: boolean;
}

export interface ReplyEmail {
  subject: string;
  text: string;
  html: string;
}

const GREETING = "Hello,";
const CLOSING = "If the steps do not fix it, reply to this email and the IT team will follow up.";
const NEEDS_INFO_INTRO =
  "We need a little more detail before we can help. Please reply with the following:";
const CHECKLIST = [
  "What you were doing when the problem happened",
  "The exact error message, if there was one",
  "When it started",
  "Which device or app it affects",
] as const;

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

/**
 * A step is folded to one line first, then redacted again. The order matters:
 * a number split across lines escapes redact, and folding would join it after.
 */
function cleanStep(step: unknown): string {
  if (typeof step !== "string") throw new TypeError("Reply email: a fix step must be a string");
  // eslint-disable-next-line no-control-regex
  const folded = step.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return redact(folded).text;
}

/** Builds a reply email from approved fields only. Pure: the same input gives the same output. */
export function buildReplyEmail(input: ReplyEmailInput): ReplyEmail {
  const { kind, ticketNumber, number, fixSteps, isTest } = input;
  if (kind !== "incident_reply" && kind !== "needs_info") {
    throw new TypeError("Reply email: unknown kind");
  }
  if (typeof ticketNumber !== "string" || !TICKET_NUMBER_RE.test(ticketNumber)) {
    throw new TypeError("Reply email: ticketNumber must be a ticket number");
  }
  const prefix = isTest === true ? "[E2E] " : "";
  const numberLine = `Your ticket number is ${ticketNumber}.`;

  if (kind === "needs_info") {
    const subject = `${prefix}More detail needed for your IT ticket ${ticketNumber}`;
    const text = [
      GREETING,
      "",
      numberLine,
      "",
      NEEDS_INFO_INTRO,
      ...CHECKLIST.map((item, i) => `${i + 1}. ${item}`),
      "",
      CLOSING,
    ].join("\n");
    const html =
      `<p>${GREETING}</p><p>${numberLine}</p><p>${NEEDS_INFO_INTRO}</p>` +
      `<ol>${CHECKLIST.map((item) => `<li>${item}</li>`).join("")}</ol><p>${CLOSING}</p>`;
    return { subject, text, html };
  }

  if (typeof number !== "string" || !HELPDESK_NUMBER_RE.test(number)) {
    throw new TypeError("Reply email: number must be a helpdesk number");
  }
  if (!Array.isArray(fixSteps)) throw new TypeError("Reply email: fixSteps must be a list");
  const steps = fixSteps
    .map(cleanStep)
    .filter((step) => step !== "")
    .slice(0, MAX_STEPS);
  if (steps.length === 0) throw new TypeError("Reply email: fixSteps must hold a step");
  const refLine = `Helpdesk reference: ${number}.`;
  const intro = "Here are the steps to try:";
  const subject = `${prefix}Your IT ticket ${ticketNumber}`;
  const text = [
    GREETING,
    "",
    numberLine,
    refLine,
    "",
    intro,
    ...steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    CLOSING,
  ].join("\n");
  const html =
    `<p>${GREETING}</p><p>${numberLine}<br>${refLine}</p><p>${intro}</p>` +
    `<ol>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol><p>${CLOSING}</p>`;
  return { subject, text, html };
}
