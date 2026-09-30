import { keywordFlags } from "./keywords.js";
import { SENSITIVE_TOPICS, type SensitiveTopic, type TopicScores } from "./topics.js";

export { SENSITIVE_TOPICS, type SensitiveTopic, type TopicScores };

/** Ticket text to check. Callers pass REDACTED text only. */
export interface CheckInput {
  title: string;
  description: string;
}

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
 */
export async function classifySensitive(
  input: CheckInput,
  checker: SensitiveChecker,
  threshold: number,
): Promise<SensitiveResult> {
  const fromKeywords = new Set(keywordFlags(`${input.title}\n${input.description}`));
  const result = await checker.check({ title: input.title, description: input.description });
  const flags = SENSITIVE_TOPICS.filter(
    (topic) => fromKeywords.has(topic) || result.scores[topic] >= threshold,
  );
  return { sensitive: flags.length > 0, flags, checker: `keywords+${result.checker}` };
}
