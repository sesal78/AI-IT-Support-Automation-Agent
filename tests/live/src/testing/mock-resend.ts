// A fetch-level mock of the Resend read API for the P5-T8c tests: it records
// every request, answers only `GET /emails/<id>` with the read key, and moves
// `last_event` to `delivered` on the mock clock. It builds the reply email the
// app's template would build from the same fields. Never opens a socket.
import { E2E_PREFIX } from "../servicenow.ts";

export const RESEND_URL = "https://api.resend.com";
/** Built from pieces so no key-shaped literal sits in the source. */
export const RESEND_READ_KEY = ["re", `MarkerResendRead${"r".repeat(20)}`].join("_");
/** The allow-listed mailbox of the mock runs; never a real address. */
export const TEST_REPLY_RECIPIENT = "marker-recipient@example.test";
/** A message is `delivered` this long after it was sent (well under 120 s). */
export const DELIVERED_AFTER_MS = 20_000;

export interface MockResendDraft {
  readonly to: string;
  readonly ticketNumber: string;
  readonly incidentNumber: string;
  readonly kind: "incident_reply" | "needs_info";
  readonly steps: readonly string[];
}

export interface MockResendEmail {
  readonly id: string;
  readonly draft: MockResendDraft;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly createdAt: number;
  readonly deliveredAfterMs: number;
  /** A fault: report this event on every read instead of the clock's answer. */
  readonly lastEvent: string | null;
}

export interface MockResendOptions {
  readonly now: () => number;
  /** How long a message takes to be `delivered` (default `DELIVERED_AFTER_MS`). */
  readonly deliveredAfterMs?: (draft: MockResendDraft) => number;
  /** Reports this `last_event` on every read (for example `bounced`). */
  readonly lastEvent?: (draft: MockResendDraft) => string;
  readonly subject?: (draft: MockResendDraft, subject: string) => string;
  readonly text?: (draft: MockResendDraft, text: string) => string;
  readonly html?: (draft: MockResendDraft, html: string) => string;
}

export interface MockResendRequest {
  readonly method: string;
  readonly url: URL;
}

export interface MockResend {
  readonly fetch: (input: URL, init: RequestInit) => Promise<Response>;
  readonly requests: readonly MockResendRequest[];
  readonly emails: Map<string, MockResendEmail>;
  /** Sends one message and returns its id, as the app's send would. */
  send(draft: MockResendDraft): string;
  /** The methods of every request, in order (`GET` only). */
  methods(): string[];
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

const prefix = `${E2E_PREFIX} `;

/** The fields the app's template fills, in the same order and wording. */
function buildEmail(draft: MockResendDraft): {
  subject: string;
  text: string;
  html: string;
} {
  const { kind, ticketNumber, incidentNumber, steps } = draft;
  const numberLine = `Your ticket number is ${ticketNumber}.`;
  if (kind === "needs_info") {
    return {
      subject: `${prefix}More detail needed for your IT ticket ${ticketNumber}`,
      text: [
        GREETING,
        "",
        numberLine,
        "",
        NEEDS_INFO_INTRO,
        ...CHECKLIST.map((item, i) => `${i + 1}. ${item}`),
        "",
        CLOSING,
      ].join("\n"),
      html:
        `<p>${GREETING}</p><p>${numberLine}</p><p>${NEEDS_INFO_INTRO}</p>` +
        `<ol>${CHECKLIST.map((item) => `<li>${item}</li>`).join("")}</ol><p>${CLOSING}</p>`,
    };
  }
  const refLine = `Helpdesk reference: ${incidentNumber}.`;
  const intro = "Here are the steps to try:";
  return {
    subject: `${prefix}Your IT ticket ${ticketNumber}`,
    text: [
      GREETING,
      "",
      numberLine,
      refLine,
      "",
      intro,
      ...steps.map((step, i) => `${i + 1}. ${step}`),
      "",
      CLOSING,
    ].join("\n"),
    html:
      `<p>${GREETING}</p><p>${numberLine}<br>${refLine}</p><p>${intro}</p>` +
      `<ol>${steps.map((step) => `<li>${step}</li>`).join("")}</ol><p>${CLOSING}</p>`,
  };
}

export function mockResend(options: MockResendOptions): MockResend {
  const now = options.now;
  const requests: MockResendRequest[] = [];
  const emails = new Map<string, MockResendEmail>();

  function send(draft: MockResendDraft): string {
    const built = buildEmail(draft);
    const id = `em_${emails.size + 1}`;
    const subject =
      options.subject === undefined ? built.subject : options.subject(draft, built.subject);
    const text = options.text === undefined ? built.text : options.text(draft, built.text);
    const html = options.html === undefined ? built.html : options.html(draft, built.html);
    emails.set(id, {
      id,
      draft,
      subject,
      text,
      html,
      createdAt: now(),
      deliveredAfterMs: options.deliveredAfterMs?.(draft) ?? DELIVERED_AFTER_MS,
      lastEvent: options.lastEvent?.(draft) ?? null,
    });
    return id;
  }

  /** The clock's answer, unless a fault pins the event. */
  function lastEventOf(email: MockResendEmail): string {
    if (email.lastEvent !== null) return email.lastEvent;
    return now() - email.createdAt >= email.deliveredAfterMs ? "delivered" : "sent";
  }

  const fetchImpl = async (input: URL, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    requests.push({ method, url: input });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const match = /^\/emails\/([A-Za-z0-9_-]{1,64})$/.exec(input.pathname);
    if (input.origin !== RESEND_URL || method !== "GET" || match === null) {
      return json({ error: "not_found" }, 404);
    }
    const authorization = new Headers(init.headers).get("Authorization");
    if (authorization !== `Bearer ${RESEND_READ_KEY}`) return json({ error: "unauthorized" }, 401);
    const email = emails.get(match[1]!);
    if (email === undefined) return json({ error: "not_found" }, 404);
    return json({
      object: "email",
      id: email.id,
      to: [email.draft.to],
      from: "help@example.test",
      created_at: new Date(email.createdAt).toISOString(),
      subject: email.subject,
      html: email.html,
      text: email.text,
      last_event: lastEventOf(email),
    });
  };

  return {
    fetch: fetchImpl,
    requests,
    emails,
    send,
    methods: () => requests.map((request) => request.method),
  };
}
