/** The sensitive topics, in the fixed order flags are reported. */
export const SENSITIVE_TOPICS = [
  "legal",
  "hr",
  "termination",
  "executive",
  "security_incident",
] as const;

export type SensitiveTopic = (typeof SENSITIVE_TOPICS)[number];

/** Probability (0-1) per topic that the ticket involves it. */
export type TopicScores = Record<SensitiveTopic, number>;
