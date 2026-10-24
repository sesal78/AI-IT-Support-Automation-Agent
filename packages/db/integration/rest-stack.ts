import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTAINER_PREFIX,
  LABEL,
  PG_NETWORK_ALIAS,
  removePgContainer,
  runSql,
  startPgContainer,
  type PgContainer,
} from "./pg-container.js";

// Pinned PostgREST image: latest stable release on Docker Hub (v16.4,
// published 2026-09-24, checked 2026-09-29).
export const POSTGREST_IMAGE = "postgrest/postgrest:v16.4";

const SCHEMA = "itsupport";
export const MIGRATIONS = [
  "0001_itsupport_foundation.sql",
  "0002_itsupport_intake.sql",
  "0003_itsupport_triage_kb.sql",
];
const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

/**
 * A throwaway Supabase-like REST stack: supabase/postgres + PostgREST on a
 * private Docker network, plus an in-process `/rest/v1` gateway on 127.0.0.1.
 */
export interface RestStack {
  pg: PgContainer;
  /** Pass as SUPABASE_URL: supabase-js appends `/rest/v1`, the gateway strips it. */
  url: string;
  /** A service_role JWT signed with this run's random PostgREST secret. */
  serviceRoleKey: string;
  network: string;
  restContainer: string;
  gateway: Server | undefined;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/** Mints an HS256 JWT the way Supabase does for its service_role key. */
export function mintJwt(secret: string, claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "supabase", iat: now, exp: now + 3600, ...claims })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/**
 * Stands in for Supabase's API gateway (Kong): forwards `/rest/v1/*` to
 * PostgREST's root and rejects any other path.
 */
function startGateway(restPort: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (!url.startsWith("/rest/v1/") && url !== "/rest/v1") {
      res.writeHead(404).end();
      return;
    }
    const upstream = request(
      {
        host: "127.0.0.1",
        port: restPort,
        method: req.method,
        path: url.slice("/rest/v1".length) || "/",
        headers: { ...req.headers, host: `127.0.0.1:${restPort}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    // Ephemeral port: parallel runs (and CI) never collide on a fixed one.
    server.listen(0, "127.0.0.1", () => resolvePromise(server));
  });
}

async function waitForRest(url: string, key: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/rest/v1/tickets?select=id&limit=1`, {
        headers: { authorization: `Bearer ${key}`, "accept-profile": SCHEMA },
      });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`PostgREST not ready after ${timeoutMs} ms: ${last}`);
}

/**
 * Starts Postgres 17 with migrations 0001 to 0003 applied, then PostgREST exposing `itsupport`.
 * `migrations` (file names in order) lets a test start an older shape, e.g. 0001 and 0002 only.
 */
export async function startRestStack(
  timeoutMs = 180_000,
  migrations: readonly string[] = MIGRATIONS,
): Promise<RestStack> {
  const suffix = randomBytes(4).toString("hex");
  const network = `${CONTAINER_PREFIX}net-${suffix}`;
  const restContainer = `${CONTAINER_PREFIX}rest-${suffix}`;
  // Fake per-run secret (PostgREST needs at least 32 characters).
  const jwtSecret = randomBytes(32).toString("hex");
  const stack: RestStack = {
    pg: { name: "", port: 0, password: "" },
    url: "",
    serviceRoleKey: mintJwt(jwtSecret, { role: "service_role" }),
    network,
    restContainer,
    gateway: undefined,
  };
  try {
    docker(["network", "create", "--label", LABEL, network]);
    stack.pg = await startPgContainer(timeoutMs, network);

    for (const file of migrations) {
      const run = runSql(stack.pg, readFileSync(resolve(migrationsDir, file), "utf8"));
      if (run.status !== 0) throw new Error(`${file} failed:\n${run.stderr}`);
    }

    // PostgREST logs in as `authenticator` and switches to the JWT's role, as
    // on Supabase. The supabase/postgres image ships `authenticator` (member of
    // anon, authenticated, service_role) without a usable password; like
    // Supabase's own setup, set one as the superuser `supabase_admin` (only a
    // superuser may alter this reserved role). Fake, per-run value.
    const authenticatorPassword = randomBytes(18).toString("hex");
    const setPassword = spawnSync(
      "docker",
      [
        "exec",
        "--env",
        `PGPASSWORD=${stack.pg.password}`,
        stack.pg.name,
        "psql",
        "--host=127.0.0.1",
        "--username=supabase_admin",
        "--dbname=postgres",
        "--no-psqlrc",
        "--set=ON_ERROR_STOP=1",
        `--command=alter role authenticator with login password '${authenticatorPassword}'`,
      ],
      { encoding: "utf8" },
    );
    if (setPassword.status !== 0) {
      throw new Error(`setting the authenticator password failed:
${setPassword.stderr}`);
    }

    docker([
      "run",
      "--detach",
      "--name",
      restContainer,
      "--label",
      LABEL,
      "--network",
      network,
      "--env",
      `PGRST_DB_URI=postgres://authenticator:${authenticatorPassword}@${PG_NETWORK_ALIAS}:5432/postgres`,
      "--env",
      `PGRST_DB_SCHEMAS=${SCHEMA}`,
      "--env",
      "PGRST_DB_ANON_ROLE=anon",
      "--env",
      `PGRST_JWT_SECRET=${jwtSecret}`,
      "--publish",
      "127.0.0.1::3000",
      POSTGREST_IMAGE,
    ]);
    const mapping = docker(["port", restContainer, "3000/tcp"]).split(/\r?\n/)[0] ?? "";
    const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
    if (!match?.[1]) throw new Error(`unexpected port mapping for ${restContainer}: "${mapping}"`);

    stack.gateway = await startGateway(Number(match[1]));
    stack.url = `http://127.0.0.1:${(stack.gateway.address() as AddressInfo).port}`;
    await waitForRest(stack.url, stack.serviceRoleKey, timeoutMs);
    return stack;
  } catch (error) {
    const logs = spawnSync("docker", ["logs", "--tail", "30", restContainer], { encoding: "utf8" });
    await removeRestStack(stack);
    throw new Error(`${String(error)}\n${logs.stdout ?? ""}${logs.stderr ?? ""}`);
  }
}

/** Removes both containers, the network and the gateway. Safe to call twice. */
export async function removeRestStack(stack: RestStack | undefined): Promise<void> {
  if (!stack) return;
  if (stack.gateway?.listening) {
    stack.gateway.closeAllConnections();
    await new Promise((resolvePromise) => stack.gateway?.close(() => resolvePromise(undefined)));
  }
  spawnSync("docker", ["rm", "--force", "--volumes", stack.restContainer], { encoding: "utf8" });
  if (stack.pg.name) removePgContainer(stack.pg);
  spawnSync("docker", ["network", "rm", stack.network], { encoding: "utf8" });
}
