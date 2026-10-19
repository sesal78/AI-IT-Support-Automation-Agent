// Builds the text passed to `itsupport.kb_search` (websearch_to_tsquery). Pure:
// no I/O. The output is either "" or lower-case words (`[a-z0-9]`, with
// a single - or . inside) joined by " or ", so user text can never reach the
// query as an operator, quote, leading minus sign or bracket. websearch_to_tsquery would otherwise require every word to
// match; `or` makes any word enough.
//
// A hyphenated or dotted word ("wi-fi", "802.11") gives its joined spelling
// ("wifi", "80211") and itself, plus its parts. Postgres indexes "Wi-Fi" as
// wi-fi/wi/fi, never "wifi", so the hyphenated form is what matches such text
// and the joined one matches text that spells it "WiFi". A separator joins only
// between letters or digits, so "restart. then" stays two words.
//
// Steps: lower-case, remove [REDACTED_*] placeholders (also lower-case ones)
// and everything that is not a-z or 0-9 (accents are folded first, so "café"
// gives "cafe"; letters of other scripts and emoji act as separators), drop
// stop words and words under 3 characters, drop duplicates, keep the first 20.
// A word over 15 characters is dropped, not cut: it is a hash or token, and a
// cut word would match nothing. 20 words of 15 characters plus 19 " or "
// separators are 376 characters, so the 400 character limit always holds.

export const KB_QUERY_MAX_WORDS = 20;
export const KB_QUERY_MIN_WORD_LENGTH = 3;
export const KB_QUERY_MAX_WORD_LENGTH = 15;

/**
 * Words too common to help a search. Includes the query words `or`, `and`, `not`,
 * and `redacted`, which is what is left of a placeholder with a bracket inside it.
 */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before " +
    "being below between both but by can cannot could did do does doing don during each few " +
    "for from further had has have having he her here hers him his how i if in into is it its " +
    "itself just me more most my myself no nor not now of off on once only or other our ours out " +
    "over own same she should so some such than that the their theirs them then there these they " +
    "this those through to too under until up very was we were what when where which while who " +
    "whom why will with would you your yours yourself redacted"
  ).split(" "),
);

const PLACEHOLDER = /\[redacted_[a-z0-9_]*\]/g;
const COMBINING_MARKS = /\p{M}+/gu;
const WORD = /[a-z0-9]+(?:[-.][a-z0-9]+)*/g;
const SEPARATOR = /[-.]/g;

/**
 * Turns free text into a safe `or` query for the knowledge base search.
 * Returns "" when no usable word is left. Throws a TypeError for a non-string.
 */
export function buildKbQuery(text: string): string {
  if (typeof text !== "string") {
    throw new TypeError("buildKbQuery expects a string");
  }
  const cleaned = text
    .toLowerCase()
    .replace(PLACEHOLDER, " ")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "");
  const words = new Set<string>();
  outer: for (const match of cleaned.matchAll(WORD)) {
    const token = match[0];
    const candidates = [token];
    if (/[-.]/.test(token)) {
      candidates.push(token.replace(SEPARATOR, ""), ...token.split(SEPARATOR));
    }
    for (const word of candidates) {
      if (
        word.length >= KB_QUERY_MIN_WORD_LENGTH &&
        word.length <= KB_QUERY_MAX_WORD_LENGTH &&
        !STOP_WORDS.has(word)
      ) {
        words.add(word);
        if (words.size === KB_QUERY_MAX_WORDS) break outer;
      }
    }
  }
  return [...words].join(" or ");
}
