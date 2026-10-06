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
// token holds lower-case letters in its prefix, a JWT in its `eyJ`). The one
// exception, a GitHub token body after an email placeholder, removes one
// `EMAIL]_` pair and creates none (its placeholder starts with `[`); only an
// EMAIL match, which shrinks the count above, can create such a pair. A JWT's
// rest after an email placeholder may hold none of them either. It then
// shrinks the count of characters outside placeholders, or, when it holds none,
// the count of placeholders other than JWT ones; no match raises either count
// without shrinking the first count above.
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
// `sk-` keys and Slack tokens are open-ended. Their rules match the prefix
// only; the body is then read and judged on the original text. Every rule
// application records what each placeholder replaced, so a placeholder counts
// as the body characters its original held. A key ends where that original
// run of body characters ends (a placeholder that runs past the end goes with
// the key, so a card inside a key gives one placeholder; one whose original
// starts outside the body alphabet stays out). The `sk-` rule runs before the
// Slack rule, so a Slack token holding an `sk-` key logs both, while an `sk-`
// key covers a Slack token glued after it. A body that is read is never read
// again, so each key is found in one pass.
//
// A JWT is read the same way, on the original text: `eyJ` starts three or
// more dot-joined base64url parts (the first three at least 10 long, any later
// one at least 1), each with up to two `=` of padding. Its rule runs after
// the number rules, which first use any boundary an AWS or GitHub key made,
// and before the open keys, so an `sk-` body never takes its `eyJ`.
// When there is no JWT, no later start inside its first part can give one
// (the rest of the read is the same), so scanning resumes after that part.
// An email may take a JWT's first parts as labels (`jo@x.com.eyJ…`); the
// JWT is then read from inside the email's original, and its rest after the
// email placeholder is replaced.

// Also the order of the log.
const TYPES = [
  "SECRET",
  "EMAIL",
  "AWS_KEY",
  "API_KEY",
  "GITHUB_TOKEN",
  "SLACK_TOKEN",
  "JWT",
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
  /** The match is a prefix; the key's body follows it. */
  open?: Open;
  /** Reads the whole match from its start: its end, or minus where to resume. */
  read?: (text: string, p: number, orig: Origin) => number;
}

interface Open {
  char: RegExp;
  /** The leading run of body characters in a placeholder's original. */
  run: RegExp;
  min: number;
}

const SK: Open = { char: /[\w-]/, run: /^[\w-]*/, min: 16 };
const XOX: Open = { char: /[A-Za-z0-9-]/, run: /^[A-Za-z0-9-]*/, min: 10 };
const PLACEHOLDER = /\[REDACTED_[A-Z0-9_]+\]/g;
const PLACEHOLDER_AT = /\[REDACTED_[A-Z0-9_]+\]/y;
const countPlaceholders = (s: string): number => s.match(PLACEHOLDER)?.length ?? 0;

/** The original text of the k-th placeholder from a position. */
type Origin = (k: number) => string;

/**
 * Reads an open key's body from `p`. Returns its end, or -1 when its original
 * run of body characters is shorter than the minimum.
 */
function bodyEnd(text: string, p: number, key: Open, orig: Origin): number {
  let raw = 0;
  for (let k = 0; p < text.length;) {
    PLACEHOLDER_AT.lastIndex = p;
    if (PLACEHOLDER_AT.test(text)) {
      const original = orig(k++);
      const run = key.run.exec(original)![0].length;
      if (run === 0) break; // its original is not body text
      raw += run;
      p = PLACEHOLDER_AT.lastIndex;
      if (run < original.length) break;
    } else if (key.char.test(text[p]!)) {
      raw++;
      p++;
    } else break;
  }
  return raw >= key.min ? p : -1;
}

/**
 * Reads a JWT on the original text: `head` from `h`, then `text` from `p`.
 * Returns [its end in `text` (-1 for none), where its first part ended (a
 * position in `head` as minus one minus its index)].
 */
function jwtRead(text: string, p: number, orig: Origin, head = "", h = 0): [number, number] {
  let part = 0;
  let len = 0;
  let pad = 0;
  let end = -1;
  let resume = text.length;
  const feed = (c: string, at: number, after: number): boolean => {
    if (/[\w-]/.test(c) && pad === 0) len++;
    else if (c === "=" && len > 0 && pad < 2) pad++;
    else if (c === "." && len >= (part < 3 ? 10 : 1)) {
      if (part++ === 0) resume = at;
      len = pad = 0;
    } else {
      if (part === 0) resume = at;
      return false;
    }
    if (part >= 2 && len >= (part === 2 ? 10 : 1)) end = after;
    return true;
  };
  for (; h < head.length; h++) if (!feed(head[h]!, -1 - h, -1)) return [end, resume];
  for (let k = 0; p < text.length;) {
    PLACEHOLDER_AT.lastIndex = p;
    const at = PLACEHOLDER_AT.test(text);
    const unit = at ? orig(k++) : text[p]!;
    const after = at ? PLACEHOLDER_AT.lastIndex : p + 1;
    for (const c of unit) if (!feed(c, p, after)) return [end, resume];
    p = after;
  }
  return [end, resume];
}

/** A JWT's end, or minus the position to resume scanning from. */
function jwtEnd(text: string, p: number, orig: Origin): number {
  if (text.startsWith("eyJ", p)) {
    const [end, resume] = jwtRead(text, p, orig);
    return end >= 0 ? end : -resume;
  }
  // After an email that took the JWT's first parts as labels.
  const email = orig(-1);
  const start = /(?<!\w)eyJ/g;
  start.lastIndex = email.indexOf("@");
  while (start.exec(email)) {
    const [end, resume] = jwtRead(text, p, orig, email, start.lastIndex - 3);
    if (end >= 0) return end;
    if (resume >= 0) break;
    start.lastIndex = -1 - resume;
  }
  return -(p + 1);
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

/**
 * Splits a glued run into its keys, left to right from its start. Every key
 * but the last has a whole key behind it; the last one also needs the end or
 * a character outside its body alphabet behind it, else it is left as is.
 */
function splitKeys(run: string, next: string): Array<[RedactionType, number]> {
  const keys: Array<[RedactionType, number]> = [];
  for (let i = 0; i < run.length; i += keys[keys.length - 1]![1]) {
    keys.push(run[i] === "A" ? ["AWS_KEY", 20] : ["GITHUB_TOKEN", run[i] === "_" ? 37 : 40]);
  }
  if ((keys[keys.length - 1]![0] === "AWS_KEY" ? /[A-Z0-9]/ : /[A-Za-z0-9]/).test(next)) {
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
  // Last in a pass, so the other rules first use any boundary a key made.
  // A JWT, or its rest after an email that took its first parts.
  { type: "JWT", pattern: /(?<!\w)eyJ|(?<=\[REDACTED_EMAIL\])(?!\[REDACTED_JWT\])/g, read: jwtEnd },
  { type: "API_KEY", pattern: /(?<!\w)sk-/g, open: SK },
  { type: "SLACK_TOKEN", pattern: /(?<!\w)xox[abp]-/g, open: XOX },
];

/**
 * The accepted parts of a candidate match as [type, length] ([] rejects it; a
 * number rejects it and says where to resume).
 */
function partsOf(
  rule: Rule,
  text: string,
  m: RegExpExecArray,
  orig: Origin,
): Array<[RedactionType, number]> | number {
  if (rule.read) {
    const stop = rule.read(text, m.index, orig);
    return stop < 0 ? -stop : [[rule.type, stop - m.index]];
  }
  const end = m.index + m[0].length;
  if (rule.open) {
    const stop = bodyEnd(text, end, rule.open, orig);
    return stop < 0 ? [] : [[rule.type, stop - m.index]];
  }
  if (rule.split) return rule.split(m[0], text.charAt(end));
  const hit = rule.fit ? rule.fit(m[0]) : !rule.accept || rule.accept(m[0]) ? m[0] : "";
  return hit === "" ? [] : [[rule.type, hit.length]];
}

interface State {
  text: string;
  /** The original text of each placeholder in `text`, in order. */
  origins: string[];
}

/** Applies one rule; returns the new state and the type of each replacement. */
function applyRule({ text, origins }: State, rule: Rule): State & { hits: RedactionType[] } {
  const { pattern } = rule;
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  let seen = 0; // origins[0..i) belong to the placeholders before `seen`
  let i = 0;
  let copied = 0;
  const next: string[] = [];
  const hits: RedactionType[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    i += countPlaceholders(text.slice(seen, m.index));
    seen = m.index;
    const base = i;
    const parts = partsOf(rule, text, m, (k) => origins[base + k]!);
    if (typeof parts === "number" || parts.length === 0) {
      // Rejected candidates consume nothing; retry from the next character.
      pattern.lastIndex = typeof parts === "number" ? parts : m.index + 1;
      continue;
    }
    out += text.slice(last, m.index);
    while (copied < i) next.push(origins[copied++]!);
    for (const [type, length] of parts) {
      next.push(text.slice(seen, seen + length).replace(PLACEHOLDER, () => origins[i++]!));
      out += `[REDACTED_${type}]`;
      seen += length;
      hits.push(type);
    }
    copied = i;
    last = pattern.lastIndex = seen;
  }
  while (copied < origins.length) next.push(origins[copied++]!);
  return { text: out + text.slice(last), origins: next, hits };
}

const KEY_TYPES = new Set<string>(["AWS_KEY", "API_KEY", "GITHUB_TOKEN", "SLACK_TOKEN", "JWT"]);
const LEGACY_RULES = RULES.filter((r) => !KEY_TYPES.has(r.type));

type Counts = Map<RedactionType, number>;

/** Repeats the given rules, in order, until a pass changes nothing. */
function toFixedPoint(state: State, rules: Rule[], counts: Counts): State {
  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of rules) {
      const res = applyRule(state, rule);
      if (res.hits.length > 0) {
        state = res;
        changed = true;
        for (const type of res.hits) counts.set(type, (counts.get(type) ?? 0) + 1);
      }
    }
  }
  return state;
}

function run(text: string, stages: Rule[][]): RedactionResult {
  if (typeof text !== "string") {
    throw new TypeError(`redact() expects a string, got ${text === null ? "null" : typeof text}`);
  }
  const counts: Counts = new Map();
  let state: State = { text, origins: text.match(PLACEHOLDER) ?? [] };
  for (const rules of stages) state = toFixedPoint(state, rules, counts);
  const log = TYPES.filter((type) => counts.has(type)).map((type) => ({
    type: type as string,
    count: counts.get(type)!,
  }));
  return { text: state.text, log };
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
