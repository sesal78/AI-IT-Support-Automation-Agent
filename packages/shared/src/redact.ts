// PII / secret redaction. Pure: no I/O, no network, no stored state.
//
// Rules run in a fixed order; each one replaces its matches with
// `[REDACTED_<TYPE>]` before the next rule runs. The whole pipeline then
// repeats until a pass changes nothing, so the result is a fixed point and a
// second redact() call is a no-op (idempotent by construction). This loop
// always terminates: every match contains a digit, a lower-case letter, `@`,
// `:`, `=` or the upper-case prefix `AKIA`, and placeholders contain none of
// them (their brackets also stop an `AKIA` forming across an edge), so each
// changing pass strictly shrinks the count of those. The one exception, a
// GitHub token body after an email placeholder, removes one `EMAIL]_` pair and
// creates none (its placeholder starts with `[`); only an EMAIL match, which
// shrinks the count above, can create such a pair.
//
// Boundaries: a space separates tokens, while `-` and `.` join digits into one
// number. A rule therefore never starts or ends inside a word or a dash/dot
// joined number, but it may sit right next to other digits across a space
// (e.g. a card followed by its CVV). A candidate rejected by its checksum does
// not consume text: scanning resumes one character later.
// Every pattern is anchored with lookbehinds so a match can only start at the
// beginning of a run, and all repetition is bounded or unambiguous, which
// keeps matching linear on adversarial input.
//
// Key rules are added on top of the older rules (all the others).
// Invariant: whatever the older rules remove at their own fixed point is also
// gone from redact()'s output. It holds by construction: redact() first runs
// the older rules alone to their fixed point, exactly as before the key rules
// existed, and every later step only replaces more text with placeholders.
// The full rule set then runs to its fixed point, so redact() stays
// idempotent. A key never starts right after a word character, except right
// after a whole key, and a `-` in front is fine (`prod-<key>`). In a glued run
// a whole key in front counts as a start boundary and a whole key behind as an
// end boundary; both checks look at most 40 characters away, so matching stays
// linear and one pipeline pass takes the whole run (an email-placeholder start
// takes one more). A key is one unbroken run of word characters
// (letters, digits and the `_` of `ghp_`), and every older rule rejects a word
// character in front of its start, so no older match starts inside a key.

export type RedactionType =
  "SECRET" | "EMAIL" | "AWS_KEY" | "GITHUB_TOKEN" | "CARD" | "SSN" | "IPV4" | "PHONE" | "AU_TFN";

export interface RedactionResult {
  text: string;
  log: Array<{ type: string; count: number }>;
}

interface Rule {
  type: RedactionType;
  pattern: RegExp;
  /** Extra check on a candidate match; a rejected match is left unchanged. */
  accept?: (match: string) => boolean;
  /** Returns the accepted prefix of a candidate match ("" rejects it). */
  fit?: (match: string) => string;
}

const digitsOf = (s: string): string => s.replace(/\D/g, "");

function luhnValid(s: string): boolean {
  const digits = digitsOf(s);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const TFN_WEIGHTS = [1, 4, 3, 7, 5, 8, 6, 9, 10];

function tfnValid(s: string): boolean {
  const digits = digitsOf(s);
  let sum = 0;
  for (let i = 0; i < TFN_WEIGHTS.length; i++) sum += Number(digits[i]) * TFN_WEIGHTS[i]!;
  return sum % 11 === 0;
}

const AWS_KEY = "AKIA[A-Z0-9]{16}";
const ANY_KEY = `(?:${AWS_KEY}|ghp_[A-Za-z0-9]{36})`;
// Not inside a word, or right after a whole key.
const KEY_START = `(?:(?<!\\w)|(?<=${ANY_KEY}))`;
// No further key character, unless a whole key starts there.
const keyEnd = (chars: string) => `(?!(?!${ANY_KEY})${chars})`;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";

const RULES: Rule[] = [
  {
    // keyword (optionally prefixed, e.g. client_secret) then ':' or '=' and a
    // value. The whole "keyword: value" is replaced so the value never leaks.
    type: "SECRET",
    pattern:
      /(?<![\w-])[\w-]*(?:password|passwd|pwd|api[ _-]?key|token|secret)[ \t]*[:=][ \t]*(?:"[^"\n]*"|'[^'\n]*'|\S+)/gi,
  },
  {
    type: "EMAIL",
    pattern:
      /(?<![\w.%+-])[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g,
  },
  {
    // Fixed length: exactly 16 upper-case letters or digits after the prefix.
    type: "AWS_KEY",
    pattern: new RegExp(KEY_START + AWS_KEY + keyEnd("[A-Z0-9]"), "g"),
  },
  {
    // Fixed length: exactly 36 letters or digits after the prefix. An email
    // whose last label is `ghp` takes the prefix first (`jo@x.ghp` + `_<body>`),
    // so a body right after an email placeholder is redacted too.
    type: "GITHUB_TOKEN",
    pattern: new RegExp(
      `(?:${KEY_START}ghp|(?<=\\[REDACTED_EMAIL\\]))_[A-Za-z0-9]{36}${keyEnd("[A-Za-z0-9]")}`,
      "g",
    ),
  },
  {
    // 13–19 contiguous digits, 4-4-4-(1..4) groups, or 4-6-(4..5) Amex/Diners
    // groups, with one consistent space or dash separator.
    type: "CARD",
    pattern:
      /(?<![\w+]|\d-)(?:\d{13,19}|\d{4}([ -])\d{4}\1\d{4}\1\d{1,4}|\d{4}([ -])\d{6}\2\d{4,5})(?!\w|-\d)/g,
    accept: luhnValid,
  },
  {
    type: "SSN",
    pattern: /(?<!\w|\d-)\d{3}-\d{2}-\d{4}(?!\w|-\d)/g,
  },
  {
    type: "IPV4",
    pattern: new RegExp(`(?<!\\w|\\d\\.)(?:${OCTET}\\.){3}${OCTET}(?!\\w|\\.\\d)`, "g"),
  },
  {
    type: "PHONE",
    pattern: new RegExp(
      [
        // International: +CC, optional (area), then 2–5 digit groups.
        "(?<![\\w+])\\+\\d{1,3}[ .-]?(?:\\(\\d{1,4}\\)[ .-]?)?\\d{1,4}(?:[ .-]?\\d{1,4}){1,4}(?!\\w|[.-]\\d)",
        // AU mobile 04xx xxx xxx, landline (0X) xxxx xxxx, 1300/1800 xxx xxx.
        "(?<!\\w|\\d[.-])(?:04\\d{2}[ -]?\\d{3}[ -]?\\d{3}|(?:\\(0[2378]\\) ?|0[2378][ -]?)\\d{4}[ -]?\\d{4}|1[38]00[ -]?\\d{3}[ -]?\\d{3})(?!\\w|[.-]\\d)",
        // US: optional 1-, then (xxx) xxx-xxxx, xxx-xxx-xxxx / xxx.xxx.xxxx,
        // or xxx xxx xxxx.
        "(?<!\\w|\\d[.-])(?:1[ .-])?(?:(?:\\(\\d{3}\\) ?|\\d{3}[.-])\\d{3}[.-]|\\d{3} \\d{3} )\\d{4}(?!\\w|[.-]\\d)",
      ].join("|"),
      "g",
    ),
    // A greedy match may run into neighbouring digit groups; drop trailing
    // groups until it fits the 15-digit E.164 limit instead of rejecting it.
    fit: (m) => {
      let s = m;
      while (digitsOf(s).length > 15) {
        const cut = s.search(/[ .-]\d+$/);
        if (cut < 0) return "";
        s = s.slice(0, cut);
      }
      return digitsOf(s).length >= 8 ? s : "";
    },
  },
  {
    type: "AU_TFN",
    pattern: /(?<!\w|\d-)\d{3}([ -]?)\d{3}\1\d{3}(?!\w|-\d)/g,
    accept: tfnValid,
  },
];

/** Applies one rule; returns the new text and the number of replacements. */
function applyRule(text: string, rule: Rule): { text: string; count: number } {
  const { pattern } = rule;
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const hit = rule.fit ? rule.fit(m[0]) : !rule.accept || rule.accept(m[0]) ? m[0] : "";
    if (hit === "") {
      // Rejected candidates consume nothing; retry from the next character.
      pattern.lastIndex = m.index + 1;
      continue;
    }
    out += text.slice(last, m.index) + `[REDACTED_${rule.type}]`;
    last = m.index + hit.length;
    pattern.lastIndex = last;
    count++;
  }
  return { text: out + text.slice(last), count };
}

const KEY_TYPES = new Set<string>(["AWS_KEY", "GITHUB_TOKEN"]);
const LEGACY_RULES = RULES.filter((r) => !KEY_TYPES.has(r.type));

type Counts = Map<RedactionType, number>;

/** Repeats the given rules, in order, until a pass changes nothing. */
function toFixedPoint(text: string, rules: Rule[], counts: Counts): string {
  let out = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of rules) {
      const res = applyRule(out, rule);
      if (res.count > 0) {
        out = res.text;
        changed = true;
        counts.set(rule.type, (counts.get(rule.type) ?? 0) + res.count);
      }
    }
  }
  return out;
}

function run(text: string, stages: Rule[][]): RedactionResult {
  if (typeof text !== "string") {
    throw new TypeError(`redact() expects a string, got ${text === null ? "null" : typeof text}`);
  }
  const counts: Counts = new Map();
  let out = text;
  for (const rules of stages) out = toFixedPoint(out, rules, counts);
  const log = RULES.filter((r) => counts.has(r.type)).map((r) => ({
    type: r.type as string,
    count: counts.get(r.type)!,
  }));
  return { text: out, log };
}

export function redact(text: string): RedactionResult {
  return run(text, [LEGACY_RULES, RULES]);
}

/**
 * The rule set as it was before the key rules. Not exported from the package
 * index: it exists so a test can compare redact() against it.
 */
export function redactLegacy(text: string): RedactionResult {
  return run(text, [LEGACY_RULES]);
}
