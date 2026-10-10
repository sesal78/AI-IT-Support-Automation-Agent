import { keywordFlags } from "./keywords.js";
import { BudgetExceededError } from "./meter.js";
import { SENSITIVE_TOPICS, type SensitiveTopic, type TopicScores } from "./topics.js";

export { SENSITIVE_TOPICS, type SensitiveTopic, type TopicScores };

/** Ticket text to check. Callers pass REDACTED text only. */
export interface CheckInput {
  title: string;
  description: string;
  /** Links the metered call and its trace span to the ticket. */
  ticketId?: string | undefined;
}

/** The `checker` text when the TypeSafe budget refused the check. */
export const CAP_REACHED_CHECKER = "keywords+cap_reached";

/** A model-backed topic scorer (TypeSafe today), kept behind an interface so it can be swapped. */
export interface SensitiveChecker {
  check(input: CheckInput): Promise<{ scores: TopicScores; checker: string }>;
}

export interface SensitiveResult {
  sensitive: boolean;
  flags: SensitiveTopic[];
  /** Which layers produced the result, e.g. `keywords+typesafe:jev-1.13.0`. */
  checker: string;
}

/**
 * Two-layer check: a topic is flagged when a keyword hits in the title or
 * description, OR the checker's score for it is >= `threshold`. The checker is
 * always called (so its flags are recorded too); a checker error propagates.
 *
 * Fail closed: when the checker's budget is refused (`BudgetExceededError`),
 * the keyword flags are kept and the result is sensitive with the checker
 * `keywords+cap_reached`, even with no flag. Any other error propagates.
 */
export async function classifySensitive(
  input: CheckInput,
  checker: SensitiveChecker,
  threshold: number,
): Promise<SensitiveResult> {
  const fromKeywords = new Set(keywordFlags(`${input.title}\n${input.description}`));
  const { title, description, ticketId } = input;
  let result: Awaited<ReturnType<SensitiveChecker["check"]>>;
  try {
    result = await checker.check({ title, description, ticketId });
  } catch (error) {
    if (!(error instanceof BudgetExceededError)) throw error;
    const flags = SENSITIVE_TOPICS.filter((topic) => fromKeywords.has(topic));
    return { sensitive: true, flags, checker: CAP_REACHED_CHECKER };
  }
  const flags = SENSITIVE_TOPICS.filter(
    (topic) => fromKeywords.has(topic) || result.scores[topic] >= threshold,
  );
  return { sensitive: flags.length > 0, flags, checker: `keywords+${result.checker}` };
}
