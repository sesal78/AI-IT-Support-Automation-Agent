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
    phone: "+61 491 570 156",
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

// Separators a digit group may carry: whitespace (incl. line breaks, NBSP and
// narrow NBSP), dash, dot, "+" (form encoding writes a space as "+"), comma,
// slash, underscore and the zero-width characters. The phone may also carry
// brackets. Each run is bounded so a long run cannot make the scan slow.
const SEP_CHARS = String.raw`\s\u00a0\u202f\u200b-\u200d\u2060\ufeff.\-+,/_`;
const SEP = `[${SEP_CHARS}]{0,8}`;
const PHONE_SEP = `[${SEP_CHARS}()]{0,8}`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const spaced = (digits: string, separator = SEP) => digits.split("").join(separator);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  commat: "@",
  plus: "+",
  period: ".",
  colon: ":",
  excl: "!",
};

const JSON_ESCAPES: Record<string, string> = { n: "\n", r: "\n", t: "\t", b: " ", f: " " };

/** JSON string escapes: `\uXXXX`, `\n` and the like, `\/`, `\"`, `\\`. */
function decodeJson(text: string): string {
  return text.replace(
    /\\(?:u([0-9a-f]{4})|(["\\/bfnrt]))/gi,
    (_escape: string, hex?: string, char?: string) =>
      hex === undefined
        ? (JSON_ESCAPES[char ?? ""] ?? char ?? "")
        : String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** HTML entities: the named ones above, and numeric ones with or without `;`. */
function decodeHtml(text: string): string {
  return text.replace(
    /&(?:#(\d{1,7});?|#x([0-9a-f]{1,6});?|([a-z]{2,8});)/gi,
    (entity: string, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? entity;
      const code = dec === undefined ? Number.parseInt(hex ?? "", 16) : Number.parseInt(dec, 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    },
  );
}

const utf8 = new TextDecoder();

/** `%xx` URL-decoding that never throws: invalid UTF-8 becomes U+FFFD. */
function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    }
    return utf8.decode(bytes);
  });
}

/**
 * The decoded view of `text`: JSON escapes, HTML entities and `%xx` decoded,
 * in three passes so a value escaped twice (or escaped in two layers) is
 * decoded too, then lower-cased.
 */
function decodedView(text: string): string {
  let view = text;
  for (let pass = 0; pass < 3; pass += 1) view = decodePercent(decodeHtml(decodeJson(view)));
  return view.toLowerCase();
}

/**
 * The decoded view with whitespace between two digits removed, so a token
 * split by a line break inside its digits joins up again. A separate view: in
 * the decoded view, unrelated digits before a card stay apart from it.
 */
const joinedView = (decoded: string) => decoded.replace(/(\d)\s+(?=\d)/g, "$1");

/** The pattern that finds one canary value in a lower-cased view. */
function patternFor(type: CanaryType, value: string, runId: string): RegExp {
  const digits = value.replace(/\D/g, "");
  const lower = value.toLowerCase();
  switch (type) {
    case "card":
    case "ssn":
      return new RegExp(String.raw`(?<!\d)${spaced(digits)}(?!\d)`, "g");
    case "phone": {
      // The value is "+<2-digit country code> <subscriber>": also find the
      // national form "0<subscriber>", the "00" international prefix, a "(0)"
      // trunk prefix after the country code, and brackets around groups.
      const country = spaced(digits.slice(0, 2), PHONE_SEP);
      const subscriber = spaced(digits.slice(2), PHONE_SEP);
      return new RegExp(
        String.raw`(?<!\d)(?:(?:\+|00)?${country}${PHONE_SEP}(?:0${PHONE_SEP})?|0${PHONE_SEP})${subscriber}(?!\d)`,
        "g",
      );
    }
    case "email":
      // A sink that form-decodes turns the "+" into a space.
      return new RegExp(escapeRegExp(lower).replace(String.raw`\+`, "[+ ]"), "g");
    default:
      // A value that ends with the run ID matches only as a whole token, so
      // run "run0001" is not found in text made for run "run00012".
      return new RegExp(escapeRegExp(lower) + (lower.endsWith(runId) ? "(?![a-z0-9])" : ""), "g");
  }
}

const DIGIT_TYPES: ReadonlySet<CanaryType> = new Set(["card", "ssn", "phone"]);
const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";

/**
 * Whether a card, SSN or phone match is part of a longer number or of a path
 * or identifier, judged from the two characters before its start:
 * - a digit and then `.`, `_`, `/` or `-` (`1.078.051.120`,
 *   `2026-10-07 8051 120`);
 * - a digit and then `,`, when the match is grouped with commas too
 *   (`1,078,051,120`); a bare comma is a list delimiter, so a CSV row of
 *   numbers is still searched;
 * - `_` or `/`, when the match is split by that same character
 *   (`file_078_05_1120.txt`, `build/078/05/1120`); a plain path segment such
 *   as `/cards/<card digits>` is still found.
 * Whitespace, NBSP and zero-width characters before a match never reject it.
 * What follows a match never rejects it: an expiry, a CVV or a suffix after a
 * card or SSN (`<card>-123`, `<card>/12/26`) is still a leak.
 */
function insideLongerToken(view: string, start: number, match: string): boolean {
  const near = view[start - 1];
  const far = view[start - 2];
  if (near === undefined) return false;
  if (".-_/".includes(near) && isDigit(far)) return true;
  if (near === "," && isDigit(far) && match.includes(",")) return true;
  return (near === "_" || near === "/") && match.includes(near);
}

function countIn(view: string, pattern: RegExp, digitType: boolean): number {
  let count = 0;
  pattern.lastIndex = 0;
  for (let found = pattern.exec(view); found !== null; found = pattern.exec(view)) {
    if (digitType && insideLongerToken(view, found.index, found[0])) {
      pattern.lastIndex = found.index + 1;
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * The canary types of the run found in `text`, in plan order, with counts.
 * Three views of the text are searched: the raw text lower-cased, the decoded
 * view (see `decodedView`) and the joined view (see `joinedView`). Card, phone
 * and SSN digits match with any separators, but not inside a longer number,
 * path or identifier (see `insideLongerToken`). Count rule: a type's count is the
 * largest of its non-overlapping match counts in the three views, so one
 * occurrence seen in several views counts once. Throws a TypeError when `text`
 * is not a string, so a missing sink body never reads as "no canaries".
 */
export function findCanaries(text: string, runId: string): CanaryHit[] {
  const canaries = buildCanaries(runId);
  if (typeof text !== "string") throw new TypeError("text must be a string");
  const decoded = decodedView(text);
  const views = [text.toLowerCase(), decoded, joinedView(decoded)];
  return canaries
    .map(({ type, value }) => {
      const pattern = patternFor(type, value, runId);
      const digitType = DIGIT_TYPES.has(type);
      const counts = views.map((view) => countIn(view, pattern, digitType));
      return { type, count: Math.max(...counts) };
    })
    .filter((hit) => hit.count > 0);
}
