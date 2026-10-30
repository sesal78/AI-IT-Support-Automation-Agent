import { slackUserId } from "@ai-it-support/shared";
import { LIMITS, type SlackBlock } from "./limits.js";
import { escapeMrkdwn, truncate } from "./text.js";

// Output-safety boundary: the card is the only place ticket text reaches Slack.
// Every ticket-derived string goes into a plain_text object, which Slack never
// parses for mentions, links or formatting. The only mrkdwn object built here is
// the decided card's reviewer mention, made from an ID that passed the Slack
// user ID rule. Fallback texts are escaped. Each builder reads the input fields
// by name (never by spreading), so no other key can reach the output.

export type ReviewEnvironment = "e2e" | "staging";

export interface KbArticleRef {
  title: string;
  slug: string;
}

export interface FixStepsDraft {
  steps: readonly string[];
  caveats: readonly string[];
}

export interface ReviewCardInput {
  reviewId: string;
  ticketId: string;
  environment: ReviewEnvironment;
  /** How long the reviewer has, such as `24h`: 1–4 digits and s, m, h or d. */
  timeout: string;
  redactedTitle: string;
  redactedDescription: string;
  category: string | null;
  priority: string | null;
  urgency: string | null;
  assignmentGroup: string | null;
  /** Policy reason codes. */
  reasons: readonly string[];
  /** Triage and sensitive-topic flags. */
  flags: readonly string[];
  /** At most 3 are shown. */
  kbArticles: readonly KbArticleRef[];
  fixSteps: FixStepsDraft | null;
}

export interface CardMessage {
  text: string;
  blocks: SlackBlock[];
}

export interface ReviewCard extends CardMessage {
  /** The thread reply with every step and the caveats, or null when the card shows it all. */
  threadSteps: CardMessage | null;
}

export interface Decision {
  decision: "approve" | "reject";
  /** The reviewer's own Slack user ID (already allow-listed by the caller). */
  slackUserId: string;
  decidedAt: Date | string;
}

const DESCRIPTION_MAX = 600;
const KB_MAX = 3;
const STEPS_SHOWN = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMEOUT = /^[1-9][0-9]{0,3}[smhd]$/;
const ENVIRONMENTS: readonly string[] = ["e2e", "staging"];

const REASON_WORDS = new Map<string, string>([
  ["ungrounded_fix", "fix steps not backed by a KB article"],
  ["low_confidence", "low triage confidence"],
  ["p1", "priority P1"],
  ["injection_suspected", "possible prompt injection"],
  ["needs_info", "ticket needs more detail"],
  ["outage_or_duplicate", "possible outage or duplicate"],
  ["cap_reached", "AI call cap reached"],
  ["llm_unavailable", "fix-step model unavailable"],
]);
const TOPIC_WORDS = new Map<string, string>([["hr", "HR"]]);

const bad = (field: string, rule: string): TypeError =>
  new TypeError(`review card: ${field} ${rule}`);

function str(value: unknown, field: string): string {
  if (typeof value !== "string") throw bad(field, "must be a string");
  return value;
}

function nullableStr(value: unknown, field: string): string | null {
  return value === null ? null : str(value, field);
}

function strList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw bad(field, "must be a list");
  return value.map((v: unknown) => str(v, field));
}

function timeout(value: unknown): string {
  if (typeof value !== "string" || !TIMEOUT.test(value)) {
    throw bad("timeout", "must be 1-4 digits then s, m, h or d");
  }
  return value;
}

/** The input, read field by field. Throws a TypeError naming the field, never its value. */
function readInput(input: ReviewCardInput) {
  const reviewId = str(input.reviewId, "reviewId");
  if (!UUID.test(reviewId)) throw bad("reviewId", "must be a UUID");
  const ticketId = str(input.ticketId, "ticketId");
  if (!UUID.test(ticketId)) throw bad("ticketId", "must be a UUID");
  const environment = str(input.environment, "environment");
  if (!ENVIRONMENTS.includes(environment)) throw bad("environment", "must be e2e or staging");
  if (!Array.isArray(input.kbArticles)) throw bad("kbArticles", "must be a list");
  const kbArticles = input.kbArticles.map((a: KbArticleRef) => ({
    title: str(a?.title, "kbArticles"),
    slug: str(a?.slug, "kbArticles"),
  }));
  const fix = input.fixSteps;
  const fixSteps =
    fix === null
      ? null
      : { steps: strList(fix?.steps, "fixSteps"), caveats: strList(fix?.caveats, "fixSteps") };
  return {
    reviewId,
    ticketId,
    environment,
    timeout: timeout(input.timeout),
    title: str(input.redactedTitle, "redactedTitle"),
    description: str(input.redactedDescription, "redactedDescription"),
    category: nullableStr(input.category, "category"),
    priority: nullableStr(input.priority, "priority"),
    urgency: nullableStr(input.urgency, "urgency"),
    group: nullableStr(input.assignmentGroup, "assignmentGroup"),
    reasons: strList(input.reasons, "reasons"),
    flags: strList(input.flags, "flags"),
    kbArticles: kbArticles.slice(0, KB_MAX),
    fixSteps,
  };
}

type Card = ReturnType<typeof readInput>;

const plain = (text: string) => ({ type: "plain_text", text, emoji: false });

const section = (blockId: string, text: string): SlackBlock => ({
  type: "section",
  block_id: blockId,
  text: plain(truncate(text, LIMITS.sectionText)),
});

const context = (blockId: string, element: Record<string, unknown>): SlackBlock => ({
  type: "context",
  block_id: blockId,
  elements: [element],
});

const len = (text: string) => Array.from(text).length;

/** Header text and fallback text from one truncated title; the fallback is escaped. */
function titled(prefix: string, title: string): { header: SlackBlock; text: string } {
  const cut = truncate(title, LIMITS.headerText - len(prefix));
  return {
    header: { type: "header", block_id: "review_header", text: plain(prefix + cut) },
    text: prefix + escapeMrkdwn(cut),
  };
}

function whyLine(reasons: string[], flags: string[]): string {
  const reasonSet = new Set(reasons);
  const isReasonCode = (code: string) => reasonSet.has(code) || REASON_WORDS.has(code);
  const topics = [...new Set(flags.filter((f) => !isReasonCode(f)))];
  const sensitive = reasonSet.has("sensitive");
  const words: string[] = [];
  const add = (word: string) => {
    if (!words.includes(word)) words.push(word);
  };
  for (const reason of reasons) {
    if (reason === "sensitive") {
      const named = topics.map((t) => TOPIC_WORDS.get(t) ?? t);
      add(named.length > 0 ? `sensitive topic (${named.join(", ")})` : "sensitive topic");
    } else {
      add(REASON_WORDS.get(reason) ?? reason);
    }
  }
  for (const flag of flags) {
    if (reasonSet.has(flag) || (sensitive && topics.includes(flag))) continue;
    add(REASON_WORDS.get(flag) ?? flag);
  }
  return `Why: ${words.length > 0 ? words.join(" · ") : "no reason given"}`;
}

function fieldsBlock(card: Card): SlackBlock {
  const field = (label: string, value: string | null) =>
    plain(truncate(`${label}: ${value ?? "not judged"}`, LIMITS.sectionFieldText));
  return {
    type: "section",
    block_id: "review_fields",
    fields: [
      field("Category", card.category),
      field("Priority", card.priority),
      field("Urgency", card.urgency),
      field("Group", card.group),
    ],
  };
}

const numbered = (steps: string[]) => steps.map((step, i) => `${i + 1}. ${step}`).join("\n");

function stepsBlock(steps: string[]): SlackBlock {
  const head = "Suggested fix steps\n";
  if (steps.length === 0) return section("review_steps", `${head}none drafted`);
  const more =
    steps.length > STEPS_SHOWN ? `\n+${steps.length - STEPS_SHOWN} more steps in the thread` : "";
  // The shown steps are cut first, so the more-steps line always fits.
  const shown = truncate(
    head + numbered(steps.slice(0, STEPS_SHOWN)),
    LIMITS.sectionText - len(more),
  );
  return section("review_steps", shown + more);
}

function threadSteps(fix: Card["fixSteps"]): CardMessage | null {
  if (fix === null || (fix.steps.length <= STEPS_SHOWN && fix.caveats.length === 0)) return null;
  let body = `Suggested fix steps\n${numbered(fix.steps)}`;
  if (fix.caveats.length > 0) body += `\nCaveats\n${fix.caveats.map((c) => `- ${c}`).join("\n")}`;
  return { text: "All suggested fix steps", blocks: [section("review_thread_steps", body)] };
}

function summaryBlock(card: Card): SlackBlock {
  const line =
    `Category ${card.category ?? "not judged"} · ${card.priority ?? "priority not judged"}` +
    ` · ${card.group ?? "group not judged"} · ticket ${card.ticketId.slice(0, 8)}`;
  return context("review_summary", plain(truncate(line, LIMITS.sectionText)));
}

const timeoutSentence = (t: string) => `No decision within ${t}: sent to the manual queue`;

/** The review card posted to the review channel, plus the optional thread reply. */
export function buildReviewCard(input: ReviewCardInput): ReviewCard {
  const card = readInput(input);
  const { header, text } = titled("Review needed: ", card.title);
  const kb =
    card.kbArticles.length > 0
      ? card.kbArticles.map((a) => `${a.title} (${a.slug})`).join(" · ")
      : "none";
  const button = (label: string, actionId: string, style: string) => ({
    type: "button",
    text: plain(label),
    action_id: actionId,
    style,
    value: card.reviewId,
  });
  return {
    text,
    blocks: [
      header,
      section("review_why", whyLine(card.reasons, card.flags)),
      fieldsBlock(card),
      section(
        "review_description",
        `Ticket (redacted)\n${truncate(card.description, DESCRIPTION_MAX)}`,
      ),
      stepsBlock(card.fixSteps?.steps ?? []),
      section("review_kb", `KB articles\n${kb}`),
      {
        type: "actions",
        block_id: "review_actions",
        elements: [
          button("Approve", "review_approve", "primary"),
          button("Reject", "review_reject", "danger"),
        ],
      },
      context(
        "review_context",
        plain(
          `Ticket ${card.ticketId.slice(0, 8)} · ${card.environment} · decide within ${card.timeout}, then it goes to the manual queue`,
        ),
      ),
    ],
    threadSteps: threadSteps(card.fixSteps),
  };
}

/**
 * The card after a decision. Its one mrkdwn object is the reviewer mention,
 * built from `slackUserId` only after it passed the Slack user ID rule.
 */
export function buildDecidedCard(input: ReviewCardInput, decision: Decision): CardMessage {
  const card = readInput(input);
  const words = new Map([
    ["approve", "Approved"],
    ["reject", "Rejected"],
  ]).get(decision?.decision);
  if (words === undefined) throw bad("decision", "must be approve or reject");
  if (!slackUserId().safeParse(decision.slackUserId).success) {
    throw bad("slackUserId", "must be a Slack user ID");
  }
  const at = new Date(decision.decidedAt);
  if (Number.isNaN(at.getTime())) throw bad("decidedAt", "must be a valid time");
  const { header, text } = titled("Reviewed: ", card.title);
  return {
    text,
    blocks: [
      header,
      fieldsBlock(card),
      context("review_decision", {
        type: "mrkdwn",
        text: `${words} by <@${decision.slackUserId}> at ${at.toISOString()}`,
      }),
      summaryBlock(card),
    ],
  };
}

/** The card after the review timed out. */
export function buildTimedOutCard(input: ReviewCardInput): CardMessage {
  const card = readInput(input);
  const { header, text } = titled("Review timed out: ", card.title);
  return {
    text,
    blocks: [
      header,
      fieldsBlock(card),
      context("review_timeout", plain(timeoutSentence(card.timeout))),
      summaryBlock(card),
    ],
  };
}

/** The thread reply posted under the card when the review timed out. */
export function buildTimeoutNote(input: { timeout: string }): { text: string } {
  return { text: escapeMrkdwn(timeoutSentence(timeout(input?.timeout))) };
}
