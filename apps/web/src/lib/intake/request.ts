import { createHash } from "node:crypto";

const MAX_HEADER_KEY_LENGTH = 200;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Client IP from the Cloudflare tunnel header, falling back to the first x-forwarded-for hop. */
export function clientIp(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || null;
}

/**
 * The `Idempotency-Key` header when set (hashed when over-long, so the stored
 * key stays bounded), otherwise a hash of email + title + description + UTC date.
 */
export function idempotencyKey(
  headers: Headers,
  body: { email: string; title: string; description: string },
  at: Date = new Date(),
): string {
  const header = headers.get("idempotency-key")?.trim();
  if (header) {
    return header.length > MAX_HEADER_KEY_LENGTH ? `h:${sha256(header)}` : header;
  }
  const day = at.toISOString().slice(0, 10);
  return sha256(JSON.stringify([body.email.toLowerCase(), body.title, body.description, day]));
}
