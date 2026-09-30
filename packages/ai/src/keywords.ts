import { SENSITIVE_TOPICS, type SensitiveTopic } from "./topics.js";

// Keyword layer of the sensitive-topic check. Each pattern is a whole word
// (or phrase), matched case-insensitively, so "HR" does not match inside
// "throw", "board" not inside "keyboard", and "fired" not on "fire".
// Only "termination" takes inflections (terminate/terminated/terminating),
// because tickets say "I am being terminated" far more often than the noun.
const KEYWORDS: Record<SensitiveTopic, readonly string[]> = {
  legal: ["legal", "lawyers?", "lawsuits?"],
  hr: ["hr", "harassment"],
  termination: ["terminat(?:e|ed|es|ing|ion)", "fired", "dismissal"],
  executive: ["executives?", "ceo", "cfo", "board"],
  security_incident: ["breach", "ransomware", "phishing", "data\\s+leaks?"],
};

const PATTERNS = SENSITIVE_TOPICS.map(
  (topic) =>
    [
      topic,
      new RegExp(`(?<![A-Za-z0-9])(?:${KEYWORDS[topic].join("|")})(?![A-Za-z0-9])`, "i"),
    ] as const,
);

/** Returns the topics whose keywords appear in `text`, each once, in topic order. */
export function keywordFlags(text: string): SensitiveTopic[] {
  return PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
}
