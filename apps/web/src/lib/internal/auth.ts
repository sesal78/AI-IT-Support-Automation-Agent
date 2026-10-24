import { createHash, timingSafeEqual } from "node:crypto";
import { createDbClient, createRepositories, type Repositories } from "@ai-it-support/db";
import { after } from "next/server";
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

// Error class name and code only: messages and stacks can carry request data.
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
function errorCode(error: unknown): string | undefined {
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" ? code : undefined;
}

/** One JSON line per failed write: source, kind, attempt, error class and code. */
function logWriteFailure(kind: string, attempt: 1 | 2, error: unknown): void {
  const line = JSON.stringify({
    level: attempt === 1 ? "warn" : "error",
    scope: "internal-api",
    msg: attempt === 1 ? "security event write failed, retrying" : "security event lost",
    source: SOURCE,
    kind,
    attempt,
    error: errorName(error),
    code: errorCode(error),
  });
  if (attempt === 1) console.warn(line);
  else console.error(line);
}

/**
 * Counts one internal-API security event; never throws. The sample is the
 * path without the query string and the method: no token, header or IP. The
 * first write is awaited, so a caller that reads the counts after its answer
 * sees the event. A failed write is retried once after the response, via
 * after(): the answer is not delayed or changed, and Next.js keeps the work
 * alive until it ends (graceful shutdown included). Without a request scope
 * (after() throws there) the retry runs before returning. Each failure is
 * logged; a failed retry is logged as "security event lost".
 */
export async function countSecurityEvent(kind: string, request: Request): Promise<void> {
  const sample = {
    path: new URL(request.url).pathname.slice(0, MAX_PATH_LENGTH),
    method: request.method,
  };
  const write = () => repos().recordSecurityEvent(SOURCE, kind, sample);
  try {
    await write();
    return;
  } catch (error) {
    logWriteFailure(kind, 1, error);
  }
  const retry = async () => {
    try {
      await write();
    } catch (error) {
      logWriteFailure(kind, 2, error);
    }
  };
  try {
    after(retry);
  } catch {
    await retry();
  }
}

async function refuse(kind: RefusalKind, request: Request): Promise<Response> {
  await countSecurityEvent(kind, request);
  // Same status, body and headers for every kind.
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/**
 * Guard for /api/internal/*. Returns null when the request may go on, or the
 * 401 response to send. A token in the query string is refused even when a
 * valid header is also present, so tokens never reach URLs or access logs.
 */
export async function requireInternalAuth(request: Request): Promise<Response | null> {
  if (hasQueryToken(new URL(request.url))) return refuse("token_in_query", request);
  const result = checkHeader(request.headers.get("authorization"));
  if (result === "ok") return null;
  return refuse(result, request);
}
