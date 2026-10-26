/**
 * Escape text for a Slack mrkdwn object. `&` goes first so the entities this
 * function adds are never escaped again; then `<` and `>`, which are the only
 * characters that open mention, channel, broadcast and link markup.
 */
export function escapeMrkdwn(text: string): string {
  if (typeof text !== "string") {
    throw new TypeError("escapeMrkdwn expects a string");
  }
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Cut text to at most `max` code points. Text that fits is returned as is;
 * otherwise the first `max - 1` code points plus an ellipsis. It works on
 * code points, so an emoji is never split, but a ZWJ sequence or a combining
 * mark can be split from its base (grapheme clusters are not tracked).
 */
export function truncate(text: string, max: number): string {
  if (typeof text !== "string") {
    throw new TypeError("truncate expects a string");
  }
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) {
    throw new RangeError("truncate max must be an integer of at least 1");
  }
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, max - 1).join("") + "…";
}
