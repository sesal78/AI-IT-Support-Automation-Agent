import { createHash, timingSafeEqual } from "node:crypto";
import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import { env } from "@/env";

type RefusalKind = "missing_token" | "bad_token" | "token_in_query";

const SOURCE = "internal_api";
const MAX_PATH_LENGTH = 200;
const QUERY_TOKEN_NAMES = new Set(["token", "access_token"]);

let repositories: Repositories | undefined;
function repos(): Repositories {
  repositories ??= createRepositories(
    createDbClient({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_DB_SCHEMA: env.SUPABASE_DB_SCHEMA,
    }),
  );
  return repositories;
}

// Hashing both sides gives equal-length buffers, so timingSafeEqual never
// short-circuits on length and the compare does not leak the token length.
function tokenMatches(provided: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(env.INTERNAL_API_TOKEN).digest();
  return timingSafeEqual(a, b);
}

function hasQueryToken(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (QUERY_TOKEN_NAMES.has(name.toLowerCase())) return true;
  }
  return false;
}

/**
 * `Authorization: Bearer <token>` only. The scheme is case-insensitive; after
 * it comes exactly one space and the rest of the value is the token as sent.
 */
function checkHeader(header: string | null): "ok" | "missing_token" | "bad_token" {
  if (header === null || header === "") return "missing_token";
  const space = header.indexOf(" ");
  const scheme = space === -1 ? header : header.slice(0, space);
  if (scheme.toLowerCase() !== "bearer") return "bad_token";
  const token = space === -1 ? "" : header.slice(space + 1);
  if (token === "") return "missing_token";
  return tokenMatches(token) ? "ok" : "bad_token";
}

// Error class name only: messages and stacks can carry request data.
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

async function refuse(kind: RefusalKind, url: URL, method: string): Promise<Response> {
  try {
    // Path without the query string and the method: no token, header or IP.
    await repos().recordSecurityEvent(SOURCE, kind, {
      path: url.pathname.slice(0, MAX_PATH_LENGTH),
      method,
    });
  } catch (error) {
    console.error(`[internal-api] security event not recorded: ${errorName(error)}`);
  }
  // Same status, body and headers for every kind.
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * Guard for /api/internal/*. Returns null when the request may go on, or the
 * 401 response to send. A token in the query string is refused even when a
 * valid header is also present, so tokens never reach URLs or access logs.
 */
export async function requireInternalAuth(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (hasQueryToken(url)) return refuse("token_in_query", url, request.method);
  const result = checkHeader(request.headers.get("authorization"));
  if (result === "ok") return null;
  return refuse(result, url, request.method);
}
