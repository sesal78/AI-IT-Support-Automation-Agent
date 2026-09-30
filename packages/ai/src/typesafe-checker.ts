import { TypeSafeClient, noul } from "@typesafe-ai/sdk";
import { z } from "zod";
import type { SensitiveChecker } from "./sensitive.js";
import { SENSITIVE_TOPICS, type SensitiveTopic } from "./topics.js";

// One Noul per topic (TypeSafe docs, checked 2026-09-28: `type: "noul"`,
// `instructions`, optional `criteria`; the answer's `noul` is P(yes), 0-1).
// The ticket is passed as JSON state and referenced by path, never spliced
// into the instructions, so ticket text stays data rather than instructions.
const QUESTIONS = {
  legal: noul(
    "Does the IT support ticket in `ticket` involve a legal matter, such as lawyers, lawsuits, legal claims or disputes, or regulatory action?",
    {
      true: "The ticket mentions or implies a legal matter.",
      false: "An ordinary IT request with no legal matter.",
    },
  ),
  hr: noul(
    "Does the IT support ticket in `ticket` involve a human-resources matter, such as a complaint about a colleague, harassment, discrimination, or disciplinary action?",
    {
      true: "The ticket mentions or implies an HR matter.",
      false: "An ordinary IT request with no HR matter.",
    },
  ),
  termination: noul(
    "Does the IT support ticket in `ticket` involve someone being terminated, fired, dismissed or laid off, including access to their accounts, devices or files?",
    {
      true: "The ticket concerns an employee's termination or dismissal.",
      false: "No employee is being terminated or dismissed.",
    },
  ),
  executive: noul(
    "Does the IT support ticket in `ticket` concern a company executive or board member (for example the CEO or CFO), or their accounts, devices or data?",
    {
      true: "The ticket concerns an executive or board member.",
      false: "No executive or board member is involved.",
    },
  ),
  security_incident: noul(
    "Does the IT support ticket in `ticket` report a possible security incident, such as a phishing email, malware or ransomware, a compromised account, unauthorized access, or a data breach or leak?",
    {
      true: "The ticket reports a possible security incident.",
      false: "An ordinary IT request with no sign of a security incident.",
    },
  ),
} satisfies Record<SensitiveTopic, ReturnType<typeof noul>>;

const probability = z.number().min(0).max(1);
const answersSchema = z.object(
  Object.fromEntries(SENSITIVE_TOPICS.map((t) => [t, z.object({ noul: probability })])) as Record<
    SensitiveTopic,
    z.ZodObject<{ noul: typeof probability }>
  >,
);

/** The SDK surface the checker uses. */
type SystemOneClient = Pick<TypeSafeClient, "systemOne">;

/**
 * Creates a SensitiveChecker backed by TypeSafe System One. Server-side only:
 * `apiKey` is the TypeSafe account key. Every failure (network, API error,
 * unexpected answer shape) throws, so the calling task fails and retries.
 */
export function createTypeSafeChecker(options: { apiKey: string }): SensitiveChecker {
  if (options.apiKey.trim() === "") throw new Error("createTypeSafeChecker: apiKey is required");
  // logLevel is pinned: the SDK logs request bodies (ticket text) at "debug",
  // and TYPESAFE_LOG_LEVEL must not be able to turn that on.
  const client: SystemOneClient = new TypeSafeClient({ apiKey: options.apiKey, logLevel: "warn" });

  return {
    async check(input) {
      const result = await client.systemOne({
        state: { ticket: { title: input.title, description: input.description } },
        questions: QUESTIONS,
      });
      const parsed = answersSchema.safeParse(result.answers);
      if (!parsed.success) {
        // Paths only: issue messages can quote the offending values.
        const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)");
        throw new Error(`TypeSafe returned an unexpected answer shape at ${paths.join(", ")}`);
      }
      const scores = Object.fromEntries(
        SENSITIVE_TOPICS.map((t) => [t, parsed.data[t].noul]),
      ) as Record<SensitiveTopic, number>;
      return { scores, checker: `typesafe:${result.model}` };
    },
  };
}
