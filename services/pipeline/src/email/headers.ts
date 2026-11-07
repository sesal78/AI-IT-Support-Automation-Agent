import { REPLY_ADDRESS_RE } from "@ai-it-support/shared";

/**
 * A value that cannot go into an email header. It names the field only: the
 * value may hold a secret or an injected header, so it is never echoed.
 */
export class EmailHeaderError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`Email header "${field}" is not safe`);
    this.name = "EmailHeaderError";
    this.field = field;
  }
}

/** Refuses CR, LF and NUL (header injection) and anything that is not a string. */
export function assertHeaderSafe(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || /[\r\n\0]/.test(value)) throw new EmailHeaderError(name);
}

/** One plain address, lower-cased. Anything else throws, naming `field`. */
export function parseRecipient(email: unknown, field = "recipient"): string {
  assertHeaderSafe(email, field);
  const normalised = email.toLowerCase();
  if (normalised.length > 254 || !REPLY_ADDRESS_RE.test(normalised)) {
    throw new EmailHeaderError(field);
  }
  return normalised;
}

/** Exact match on the normalised address; the list holds lower-case addresses. */
export function isAllowedRecipient(email: string, allowed: readonly string[]): boolean {
  let address: string;
  try {
    address = parseRecipient(email);
  } catch {
    return false;
  }
  return allowed.includes(address);
}
