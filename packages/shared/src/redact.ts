// PII / secret redaction. Pure: no I/O, no network, no stored state.
//
// Rules run in a fixed order; each one replaces its matches with
// `[REDACTED_<TYPE>]` before the next rule runs. The whole pipeline then
// repeats until a pass changes nothing, so the result is a fixed point and a
// second redact() call is a no-op (idempotent by construction). This loop
// always terminates: every match contains a digit, a lower-case letter, `@`,
// `:`, `=` or the upper-case prefix `AKIA`, and placeholders contain none of
// them (their brackets also stop an `AKIA` forming across an edge), so each
// changing pass strictly shrinks the count of those (an `sk-` key or Slack
// token holds lower-case letters in its prefix). The one exception, a
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
// idempotent. A run of keys never starts right after a word character, but a
// `-` in front is fine (`prod-<key>`). Keys glued with no separator are split
// left to right from the run's start, so a key-shaped window inside a token
// body is never taken; a run that starts after a word character is left whole
// (`x<key><key>`). The split is deterministic (`AKIA` and `ghp_` differ in
// their first letter), so matching stays linear. A key is one unbroken run of
// word characters (letters, digits and the `_` of `ghp_`), and every older
// rule rejects a word character in front of its start, so no older match
// starts inside a key.
//
// `sk-` keys and Slack tokens are open-ended: each runs to the end of its
// word-and-dash run, so it never ends inside a word, and it takes the
// placeholders that older rules left in that run (a card inside a key still
// gives one placeholder). They run before the AWS/GitHub rule, so a fixed key
// inside one goes with it. A GitHub token glued in front of one ends there
// (`ghp_<36>sk-<key>`) and both are redacted.

// Also the order of the log.
const TYPES = [
  "SECRET",
  "EMAIL",
  "AWS_KEY",
  "API_KEY",
  "GITHUB_TOKEN",
  "SLACK_TOKEN",
  "CARD",
  "SSN",
  "IPV4",
  "PHONE",
  "AU_TFN",
] as const;
export type RedactionType = (typeof TYPES)[number];

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
  /** Splits a match into parts replaced one by one ([] rejects it). */
  split?: (match: string, next: string) => Array<[RedactionType, number]>;
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

// Fixed length: AKIA plus 16 upper-case letters or digits, or ghp_ plus 36
// letters or digits.
const KEY = "(?:AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{36})";

const PLACEHOLDER = "\\[REDACTED_[A-Z0-9_]+\\]";

// An open-ended key's prefix: then `min` characters of `cls`, or fewer of
// them and a placeholder. Both alternatives scan the same class, so a failed
// check reads fewer than `min` characters (linear).
const opener = (prefix: string, cls: string, min: number): string =>
  `${prefix}(?=${cls}{${min}}|${cls}*${PLACEHOLDER})`;
const SK = opener("sk-", "[\\w-]", 16);
const XOX = opener("xox[abp]-", "[A-Za-z0-9-]", 10);
const OPENS_KEY = new RegExp(`^(?:${SK}|${XOX})`);

// The rest of the word-and-dash run, placeholders included. A number that the
// older rules skip because it follows `digit-` (`…7-0412 345 678`) goes too.
const OPEN_BODY = `(?:[\\w-]|${PLACEHOLDER})+(?:(?<=-\\d+)(?:[ .]\\d+)+)?`;

/**
 * Splits a glued run into its keys, left to right from its start. Every key
 * but the last has a whole key behind it; the last one also needs the end or
 * a character outside its body alphabet behind it (or, for a GitHub token,
 * an `sk-` key or Slack token), else it is left as is. `next` is the rest of
 * the text.
 */
function splitKeys(run: string, next: string): Array<[RedactionType, number]> {
  const keys: Array<[RedactionType, number]> = [];
  for (let i = 0; i < run.length; i += keys[keys.length - 1]![1]) {
    keys.push(run[i] === "A" ? ["AWS_KEY", 20] : ["GITHUB_TOKEN", run[i] === "_" ? 37 : 40]);
  }
  const aws = keys[keys.length - 1]![0] === "AWS_KEY";
  if (aws ? /^[A-Z0-9]/.test(next) : /^[A-Za-z0-9]/.test(next) && !OPENS_KEY.test(next)) {
    keys.pop();
  }
  return keys;
}

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
    type: "API_KEY",
    pattern: new RegExp(`(?<!\\w)${SK}${OPEN_BODY}`, "g"),
  },
  {
    type: "SLACK_TOKEN",
    pattern: new RegExp(`(?<!\\w)${XOX}${OPEN_BODY}`, "g"),
  },
  {
    // AWS keys and GitHub tokens (splitKeys names each key's type): a run of
    // whole keys glued together. An email whose last label is `ghp` takes the
    // prefix first (`jo@x.ghp` + `_<body>`), so a run may also start with a
    // token body right after an email placeholder.
    type: "AWS_KEY",
    pattern: new RegExp(`(?<=\\[REDACTED_EMAIL\\])_[A-Za-z0-9]{36}${KEY}*|(?<!\\w)${KEY}+`, "g"),
    split: splitKeys,
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

/** The accepted parts of a candidate match as [type, length] ([] rejects it). */
function partsOf(rule: Rule, match: string, next: string): Array<[RedactionType, number]> {
  if (rule.split) return rule.split(match, next);
  const hit = rule.fit ? rule.fit(match) : !rule.accept || rule.accept(match) ? match : "";
  return hit === "" ? [] : [[rule.type, hit.length]];
}

/** Applies one rule; returns the new text and the type of each replacement. */
function applyRule(text: string, rule: Rule): { text: string; hits: RedactionType[] } {
  const { pattern } = rule;
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  const hits: RedactionType[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const parts = partsOf(rule, m[0], text.slice(m.index + m[0].length));
    if (parts.length === 0) {
      // Rejected candidates consume nothing; retry from the next character.
      pattern.lastIndex = m.index + 1;
      continue;
    }
    out += text.slice(last, m.index);
    last = m.index;
    for (const [type, length] of parts) {
      out += `[REDACTED_${type}]`;
      last += length;
      hits.push(type);
    }
    pattern.lastIndex = last;
  }
  return { text: out + text.slice(last), hits };
}

const KEY_TYPES = new Set<string>(["AWS_KEY", "API_KEY", "GITHUB_TOKEN", "SLACK_TOKEN"]);
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
      if (res.hits.length > 0) {
        out = res.text;
        changed = true;
        for (const type of res.hits) counts.set(type, (counts.get(type) ?? 0) + 1);
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
  const log = TYPES.filter((type) => counts.has(type)).map((type) => ({
    type: type as string,
    count: counts.get(type)!,
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
