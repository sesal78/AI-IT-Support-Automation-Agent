import type { SlackMessage } from "./limits.js";

/** Thrown when a message holds mrkdwn that could mention, broadcast or link. */
export class LiveMarkupError extends Error {
  constructor(where: string) {
    super(`live markup (<) in ${where}`);
    this.name = "LiveMarkupError";
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when anything below `node` is a mrkdwn text object containing `<`. */
function hasLiveMrkdwn(node: unknown, depth = 0): boolean {
  if (depth > 20) return true; // Too deep to trust: fail closed.
  if (Array.isArray(node)) return node.some((n) => hasLiveMrkdwn(n, depth + 1));
  if (!isObj(node)) return false;
  if (node.type === "mrkdwn" && typeof node.text === "string" && node.text.includes("<")) {
    return true;
  }
  return Object.values(node).some((v) => hasLiveMrkdwn(v, depth + 1));
}

/**
 * Throw when any mrkdwn text object, or the fallback text, contains `<`.
 * Escaped text has no `<`, so no mention, broadcast, channel or link markup
 * can come from data. plain_text objects are not parsed by Slack and pass.
 * The error names the block, never the text.
 */
export function assertNoLiveMarkup(message: SlackMessage): void {
  if (typeof message.text === "string" && message.text.includes("<")) {
    throw new LiveMarkupError("the fallback text");
  }
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  blocks.forEach((block, i) => {
    if (!hasLiveMrkdwn(block)) return;
    const id = isObj(block) ? block.block_id : undefined;
    throw new LiveMarkupError(
      typeof id === "string" && id !== "" ? `block_id ${JSON.stringify(id)}` : `the block at index ${i}`,
    );
  });
}
