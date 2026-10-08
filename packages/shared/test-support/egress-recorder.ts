// Egress recorder for integration tests (plan §4.3, P3-T12). TEST CODE ONLY:
// never import it from `src`. It starts an msw server that fails any request
// to an un-mocked host, records every outbound request that does not go to
// 127.0.0.1, and `assertClean()` throws when a recorded request leaks a PII
// canary of the run, a string registered with `forbid()`, or an email address.
//
// Privacy rules of this file:
// - An error message names the method, the host, where it was found and the
//   type of finding. It never holds a recorded value, a path or a query.
// - `authorization` is never recorded. Other secret-bearing headers
//   (cookie, x-api-key, ...) are recorded as "[omitted]". Both are still
//   scanned for canaries before the value is dropped.
// - Only 127.0.0.1 passes through. `localhost` and `[::1]` are treated like
//   any other host, so they fail unless mocked (fail closed).
//
// Scan limits (documented, not covered): base64 or other binary-in-text
// encodings of a canary, and UTF-16 bodies. Interception limit: msw patches
// global fetch and node:http/https. It does NOT see the npm `undici` package's
// own request()/fetch() (verified with undici 8.11.2: the call goes out to the
// real host). Do not use that client in code under integration test.
// The recorder does not run the full redact() rules: IDs and timestamps give
// false card hits.
import { randomBytes } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { setupServer, type SetupServer } from "msw/node";
import { buildCanaries } from "../src/canaries.js";

export type RecordedRequest = {
  method: string;
  host: string;
  path: string;
  query: string;
  /** Lower-case names. No `authorization`; secret-bearing values are "[omitted]". */
  headers: Record<string, string>;
  /** Decoded text (gzip, deflate and br unpacked first). */
  body: string;
};

export type EgressRecorder = {
  /** The run ID whose canaries every `assertClean()` call checks. */
  readonly runId: string;
  /** Starts intercepting. Safe to call twice. */
  start(): void;
  /** Stops intercepting and forgets everything, including mocks and forbidden strings. */
  stop(): void;
  /** Mocks an origin such as `https://api.typesafe.ai`. Default reply: 200 `{}`. */
  mock(origin: string, resolver?: HttpResponseResolver): void;
  /** Registers a string that must never leave the process. Reported as `custom#N`. */
  forbid(value: string): void;
  /** Forgets recorded requests and violations; keeps mocks and forbidden strings. */
  reset(): void;
  /** Recorded requests (without 127.0.0.1 traffic). */
  requests(): readonly RecordedRequest[];
  /** Throws when a leak, an unreadable body or an un-mocked host was seen. */
  assertClean(runId?: string): void;
};

type Haystack = { where: string; text: string };
type Entry = { record: RecordedRequest; haystacks: Haystack[]; unreadable: string | undefined };

const LOOPBACK = "127.0.0.1";
const MAX_BODY = 64 * 1024 * 1024;
const SECRET_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "apikey",
  "x-auth-token",
]);

function decodeBody(raw: Buffer, encodingHeader: string): Buffer {
  let data = raw;
  const encodings = encodingHeader
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "identity")
    .reverse();
  // A gzip body without a header is still unpacked.
  if (encodings.length === 0 && data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) {
    encodings.push("gzip");
  }
  const options = { maxOutputLength: MAX_BODY };
  for (const encoding of encodings) {
    if (encoding === "gzip" || encoding === "x-gzip") data = gunzipSync(data, options);
    else if (encoding === "br") data = brotliDecompressSync(data, options);
    else if (encoding === "deflate") {
      try {
        data = inflateSync(data, options);
      } catch {
        data = inflateRawSync(data, options);
      }
    } else throw new Error("unsupported content-encoding");
  }
  return data;
}

function codePoint(code: number, fallback: string): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Percent, JSON-\u and numeric-entity decoding, repeated until stable (max 3 rounds). */
function unescapeText(text: string): string {
  let current = text;
  for (let round = 0; round < 3; round++) {
    const next = current
      .replace(/%([0-9a-f]{2})/gi, (all, hex: string) => {
        const code = parseInt(hex, 16);
        return code < 0x80 ? String.fromCharCode(code) : all;
      })
      .replace(/\\u([0-9a-f]{4})/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#x([0-9a-f]{1,6});/gi, (all, hex: string) => codePoint(parseInt(hex, 16), all))
      .replace(/&#(\d{1,7});/g, (all, dec: string) => codePoint(parseInt(dec, 10), all));
    if (next === current) break;
    current = next;
  }
  return current;
}

const isLocalPart = (c: string) => /[a-z0-9._%+-]/.test(c);
const isDomainPart = (c: string) => /[a-z0-9.-]/.test(c);

/** Linear-time email finder over lower-case text: walks outwards from each `@`. */
function hasEmail(text: string): boolean {
  let at = text.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > 0 && at - start < 64 && isLocalPart(text[start - 1] ?? "")) start--;
    let end = at + 1;
    while (end < text.length && end - at < 256 && isDomainPart(text[end] ?? "")) end++;
    const domain = text.slice(at + 1, end);
    if (start < at && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain)) return true;
    at = text.indexOf("@", at + 1);
  }
  return false;
}

export function createEgressRecorder(options: { runId?: string } = {}): EgressRecorder {
  const runId = options.runId ?? randomBytes(4).toString("hex");
  buildCanaries(runId); // validates the run ID
  const server: SetupServer = setupServer();
  const entries: Entry[] = [];
  const unmocked = new Set<string>();
  const forbidden: string[] = [];
  let running = false;

  async function capture(request: Request): Promise<void> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    const haystacks: Haystack[] = [
      { where: "path", text: url.pathname },
      { where: "query", text: url.search },
    ];
    request.headers.forEach((value, name) => {
      const key = name.toLowerCase();
      haystacks.push({ where: `header ${key}`, text: value });
      if (key === "authorization") return;
      headers[key] = SECRET_HEADERS.has(key) ? "[omitted]" : value;
    });
    let body = "";
    let unreadable: string | undefined;
    try {
      const raw = Buffer.from(await request.clone().arrayBuffer());
      body = decodeBody(raw, request.headers.get("content-encoding") ?? "").toString("utf8");
    } catch {
      unreadable = "body could not be decoded";
    }
    haystacks.push({ where: "body", text: body });
    entries.push({
      record: {
        method: request.method,
        host: url.host,
        path: url.pathname,
        query: url.search,
        headers,
        body,
      },
      haystacks,
      unreadable,
    });
  }

  function findingsOf(entry: Entry, runIds: string[]): string[] {
    const canaries = runIds.flatMap((id) => buildCanaries(id));
    const found = new Set<string>();
    for (const { where, text } of entry.haystacks) {
      const lower = text.toLowerCase();
      for (const view of [lower, unescapeText(lower)]) {
        let rest = view;
        for (const { type, value } of canaries) {
          const needle = value.toLowerCase();
          let hit = false;
          for (const form of [needle, needle.replaceAll(" ", "")]) {
            if (!rest.includes(form)) continue;
            hit = true;
            // A canary email is reported once, as its type, not as a raw email too.
            if (type === "email") rest = rest.replaceAll(form, " ");
          }
          if (hit) found.add(`${where}: ${type}`);
        }
        forbidden.forEach((value, index) => {
          if (view.includes(value.toLowerCase())) found.add(`${where}: custom#${index + 1}`);
        });
        if (hasEmail(rest)) found.add(`${where}: unredacted:EMAIL`);
      }
    }
    return [...found];
  }

  return {
    runId,
    start() {
      if (running) return;
      running = true;
      server.listen({
        onUnhandledRequest(request) {
          const url = new URL(request.url);
          if (url.hostname === LOOPBACK) return; // passes through, not recorded
          unmocked.add(url.host);
          throw new Error(
            `Egress recorder: no mock for host ${url.host}; the request was blocked (no real network call)`,
          );
        },
      });
      // msw patches http.request/https.request on the CJS module object. Without
      // this sync, `import { request } from "node:https"` keeps the real function
      // and the call leaves the process unrecorded (verified with msw 2.15.0).
      syncBuiltinESMExports();
    },
    stop() {
      if (running) {
        server.close();
        syncBuiltinESMExports();
      }
      running = false;
      server.resetHandlers();
      entries.length = 0;
      unmocked.clear();
      forbidden.length = 0;
    },
    mock(origin, resolver) {
      const base = new URL(origin).origin;
      server.use(
        http.all(`${base}/*`, async (info) => {
          await capture(info.request);
          return resolver ? resolver(info) : HttpResponse.json({});
        }),
      );
    },
    forbid(value) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new TypeError("forbid() needs a non-empty string");
      }
      forbidden.push(value);
    },
    reset() {
      entries.length = 0;
      unmocked.clear();
    },
    requests() {
      return entries.map((entry) => entry.record);
    },
    assertClean(extraRunId) {
      const runIds =
        extraRunId === undefined || extraRunId === runId ? [runId] : [runId, extraRunId];
      const problems: string[] = [];
      for (const host of unmocked) problems.push(`${host}: request to a host with no mock`);
      for (const entry of entries) {
        const label = `${entry.record.method} ${entry.record.host}`;
        if (entry.unreadable) problems.push(`${label}: ${entry.unreadable} (fail closed)`);
        for (const finding of findingsOf(entry, runIds)) problems.push(`${label}: ${finding}`);
      }
      if (problems.length > 0) {
        throw new Error(`Egress recorder: leak check failed.\n${problems.join("\n")}`);
      }
    },
  };
}
