// PII / secret redaction. Pure: no I/O, no network, no stored state.
//
// Rules run in a fixed order; each one replaces its matches with
// `[REDACTED_<TYPE>]` before the next rule runs. Placeholders contain no
// digits, `@`, `:` or `=`, so a second pass matches nothing (idempotent).
// Every pattern is anchored with lookbehinds so a match can only start at the
// beginning of a run, and all repetition is bounded or unambiguous, which
// keeps matching linear on adversarial input.

export type RedactionType = "SECRET" | "EMAIL" | "CARD" | "SSN" | "IPV4" | "PHONE" | "AU_TFN";

export interface RedactionResult {
  text: string;
  log: Array<{ type: string; count: number }>;
}

interface Rule {
  type: RedactionType;
  pattern: RegExp;
  /** Extra check on a candidate match; a rejected match is left unchanged. */
  accept?: (match: string) => boolean;
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
    // 13–19 contiguous digits, 4-4-4-(1..4) groups, or 4-6-(4..5) Amex/Diners
    // groups, with one consistent space or dash separator.
    type: "CARD",
    pattern:
      /(?<![\w+]|\d[ -])(?:\d{13,19}|\d{4}([ -])\d{4}\1\d{4}\1\d{1,4}|\d{4}([ -])\d{6}\2\d{4,5})(?!\w|[ -]\d)/g,
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
        "(?<![\\w+])\\+\\d{1,3}[ .-]?(?:\\(\\d{1,4}\\)[ .-]?)?\\d{1,4}(?:[ .-]?\\d{1,4}){1,4}(?!\\w|[ .-]\\d)",
        // AU mobile 04xx xxx xxx, landline (0X) xxxx xxxx, 1300/1800 xxx xxx.
        "(?<!\\w|\\d[ .-])(?:04\\d{2}[ -]?\\d{3}[ -]?\\d{3}|(?:\\(0[2378]\\) ?|0[2378][ -]?)\\d{4}[ -]?\\d{4}|1[38]00[ -]?\\d{3}[ -]?\\d{3})(?!\\w|[ .-]\\d)",
        // US: optional 1-, then (xxx) xxx-xxxx or xxx-xxx-xxxx / xxx.xxx.xxxx.
        "(?<!\\w|\\d[ .-])(?:1[ .-])?(?:\\(\\d{3}\\) ?|\\d{3}[.-])\\d{3}[.-]\\d{4}(?!\\w|[.-]\\d)",
      ].join("|"),
      "g",
    ),
    accept: (m) => {
      const n = digitsOf(m).length;
      return n >= 8 && n <= 15;
    },
  },
  {
    type: "AU_TFN",
    pattern: /(?<!\w|\d[ -])\d{3}([ -]?)\d{3}\1\d{3}(?!\w|[ -]\d)/g,
    accept: tfnValid,
  },
];

export function redact(text: string): RedactionResult {
  if (typeof text !== "string") {
    throw new TypeError(`redact() expects a string, got ${text === null ? "null" : typeof text}`);
  }
  const log: RedactionResult["log"] = [];
  let out = text;
  for (const rule of RULES) {
    let count = 0;
    out = out.replace(rule.pattern, (match: string) => {
      if (rule.accept && !rule.accept(match)) return match;
      count++;
      return `[REDACTED_${rule.type}]`;
    });
    if (count > 0) log.push({ type: rule.type, count });
  }
  return { text: out, log };
}
