// PII canaries for tests (plan §4.3). Test data only: every value is a
// published documentation example, not a real secret. This is the one path
// that .gitleaks.toml and .semgrepignore allow-list, so secret-shaped test
// data lives here and nowhere else. Pure: no I/O, no stored state.

/** The 10 canary types, in plan order. */
export const CANARY_TYPES = [
  "ssn",
  "card",
  "email",
  "phone",
  "ipv4",
  "ipv6",
  "api_key",
  "aws_key",
  "github_token",
  "password",
] as const;

export type CanaryType = (typeof CANARY_TYPES)[number];
export type Canary = { type: CanaryType; value: string };
/** A canary type found in a text and how often. Never the value. */
export type CanaryHit = { type: CanaryType; count: number };

const RUN_ID = /^[a-z0-9]{4,12}$/;

/**
 * The 10 canaries of one run. The email, API key, GitHub token and password
 * carry the run ID, so a hit in a sink can be traced to its run. Throws a
 * TypeError for an invalid run ID. The rejected value is never echoed.
 */
export function buildCanaries(runId: string): Canary[] {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw new TypeError("runId must be 4-12 lower-case letters or digits");
  }
  const values: Record<CanaryType, string> = {
    ssn: "078-05-1120",
    card: "4111 1111 1111 1111",
    email: `canary+${runId}@example.com`,
    phone: "+61 412 345 678",
    ipv4: "203.0.113.42",
    ipv6: "2001:db8::42",
    api_key: `sk-test-CANARY${runId}`,
    aws_key: "AKIAIOSFODNN7EXAMPLE",
    github_token: `ghp_${`CANARY${runId}`.padEnd(36, "0")}`,
    password: `Hunter2!Canary${runId}`,
  };
  return CANARY_TYPES.map((type) => ({ type, value: values[type] }));
}

/** One ticket description that contains all 10 canaries of the run. */
export function canaryTicketText(runId: string): string {
  const value = Object.fromEntries(
    buildCanaries(runId).map((canary) => [canary.type, canary.value]),
  );
  return [
    "My laptop cannot reach the VPN since this morning.",
    `To verify me: SSN ${value.ssn}, card ${value.card}.`,
    `Reply to ${value.email} or call ${value.phone}.`,
    `The laptop has the addresses ${value.ipv4} and ${value.ipv6}.`,
    `My sync script uses the API key ${value.api_key}, the AWS key ${value.aws_key}`,
    `and the GitHub token ${value.github_token}.`,
    `Password: ${value.password}`,
  ].join("\n");
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * The canary types of the run found in `text`, in plan order, with counts.
 * The card and the phone are also found with their spaces removed. Throws a
 * TypeError when `text` is not a string, so a missing sink body never reads
 * as "no canaries".
 */
export function findCanaries(text: string, runId: string): CanaryHit[] {
  const canaries = buildCanaries(runId);
  if (typeof text !== "string") throw new TypeError("text must be a string");
  return canaries
    .map(({ type, value }) => {
      const compact = value.replaceAll(" ", "");
      const count = countOf(text, value) + (compact === value ? 0 : countOf(text, compact));
      return { type, count };
    })
    .filter((hit) => hit.count > 0);
}
