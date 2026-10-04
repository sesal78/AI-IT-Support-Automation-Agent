import { createHash } from "node:crypto";

const MAX_HEADER_KEY_LENGTH = 200;

/** Channels that own a slice of the idempotency key space (plan C14). */
const KEY_NAMESPACES = ["web", "email", "test"] as const;
export type KeyNamespace = (typeof KEY_NAMESPACES)[number];

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Client IP from the Cloudflare tunnel header, falling back to the first x-forwarded-for hop. */
export function clientIp(headers: Headers): string | null {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || null;
}

/**
 * `<namespace>:<raw>`. The namespace is chosen by the server-side caller, never
 * read from the request, so one channel cannot claim another channel's key.
 * The messages name no key value: a key can come from a request.
 */
export function namespacedKey(namespace: KeyNamespace, raw: string): string {
  if (!KEY_NAMESPACES.includes(namespace)) throw new TypeError("unknown idempotency namespace");
  if (raw === "") throw new TypeError("empty idempotency key");
  return `${namespace}:${raw}`;
}

/**
 * The form path's key, always under `web:`. The `Idempotency-Key` header when
 * set (hashed when over-long, so the stored key stays bounded), otherwise a hash
 * of email + title + description + UTC date. A prefix sent by the client is
 * neither trusted nor stripped: `email:abc` is stored as `web:email:abc`.
 */
export function idempotencyKey(
  headers: Headers,
  body: { email: string; title: string; description: string },
  at: Date = new Date(),
): string {
  const header = headers.get("idempotency-key")?.trim();
  if (header) {
    return namespacedKey(
      "web",
      header.length > MAX_HEADER_KEY_LENGTH ? `h:${sha256(header)}` : header,
    );
  }
  const day = at.toISOString().slice(0, 10);
  return namespacedKey(
    "web",
    sha256(JSON.stringify([body.email.toLowerCase(), body.title, body.description, day])),
  );
}
