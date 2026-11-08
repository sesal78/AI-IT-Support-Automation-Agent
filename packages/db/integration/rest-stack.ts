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
// Pinned GoTrue image: the version the shared stack runs (H26, read from
// /auth/v1/health on 2026-11-06). Same tag convention as the images above.
export const GOTRUE_VERSION = "v2.189.0";
export const GOTRUE_IMAGE = `supabase/gotrue:${GOTRUE_VERSION}`;

const SCHEMA = "itsupport";
// Every up file, in order, so each REST-stack test runs on the schema the
// shared database will have (0004 locks the sequences, 0005 adds reviews,
// 0006 adds notifications and the ticket number, 0007 the built-in helpdesk tables).
export const MIGRATIONS = [
  "0001_itsupport_foundation.sql",
  "0002_itsupport_intake.sql",
  "0003_itsupport_triage_kb.sql",
  "0004_itsupport_lock_sequences.sql",
  "0005_itsupport_reviews.sql",
  "0006_itsupport_helpdesk.sql",
  "0007_itsupport_builtin_helpdesk.sql",
];
const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

/**
 * A throwaway Supabase-like stack: supabase/postgres + PostgREST + GoTrue on a
 * private Docker network, plus an in-process gateway on 127.0.0.1 that serves
 * `/rest/v1` and `/auth/v1`. PostgREST and GoTrue share one per-run JWT secret.
 */
export interface RestStack {
  pg: PgContainer;
  /** Pass as SUPABASE_URL: supabase-js appends `/rest/v1` or `/auth/v1`, the gateway strips it. */
  url: string;
  /** A service_role JWT signed with this run's random PostgREST secret. */
  serviceRoleKey: string;
  network: string;
  restContainer: string;
  authContainer: string;
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
 * PostgREST's root, `/auth/v1/*` to GoTrue's root and rejects any other path.
 */
function startGateway(routes: Record<string, number>): Promise<Server> {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    const prefix = Object.keys(routes).find(
      (candidate) => url === candidate || url.startsWith(`${candidate}/`),
    );
    const port = prefix === undefined ? undefined : routes[prefix];
    if (prefix === undefined || port === undefined) {
      res.writeHead(404).end();
      return;
    }
    const upstream = request(
      {
        host: "127.0.0.1",
        port,
        method: req.method,
        path: url.slice(prefix.length) || "/",
        headers: { ...req.headers, host: `127.0.0.1:${port}` },
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

async function waitForAuth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/auth/v1/health`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`GoTrue not ready after ${timeoutMs} ms: ${last}`);
}

function publishedPort(container: string, port: string): number {
  const mapping = docker(["port", container, `${port}/tcp`]).split(/\r?\n/)[0] ?? "";
  const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
  if (!match?.[1]) throw new Error(`unexpected port mapping for ${container}: "${mapping}"`);
  return Number(match[1]);
}

/**
 * Sets a login password on a reserved role of the supabase/postgres image, as
 * the superuser `supabase_admin` (only a superuser may alter these roles).
 */
function setRolePassword(pg: PgContainer, role: string, password: string): void {
  const run = spawnSync(
    "docker",
    [
      "exec",
      "--env",
      `PGPASSWORD=${pg.password}`,
      pg.name,
      "psql",
      "--host=127.0.0.1",
      "--username=supabase_admin",
      "--dbname=postgres",
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      `--command=alter role ${role} with login password '${password}'`,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`setting the ${role} password failed:\n${run.stderr}`);
}

/**
 * Starts Postgres 17 with the migrations applied, then PostgREST exposing
 * `itsupport` and GoTrue (sign-up disabled) on the same database and JWT secret.
 * `migrations` (file names in order) lets a test start an older shape, e.g. 0001 and 0002 only.
 */
export async function startRestStack(
  timeoutMs = 180_000,
  migrations: readonly string[] = MIGRATIONS,
): Promise<RestStack> {
  const suffix = randomBytes(4).toString("hex");
  const network = `${CONTAINER_PREFIX}net-${suffix}`;
  const restContainer = `${CONTAINER_PREFIX}rest-${suffix}`;
  const authContainer = `${CONTAINER_PREFIX}auth-${suffix}`;
  // Fake per-run secret (PostgREST needs at least 32 characters).
  const jwtSecret = randomBytes(32).toString("hex");
  const stack: RestStack = {
    pg: { name: "", port: 0, password: "" },
    url: "",
    serviceRoleKey: mintJwt(jwtSecret, { role: "service_role" }),
    network,
    restContainer,
    authContainer,
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
    // on Supabase; GoTrue logs in as `supabase_auth_admin`, which owns the
    // `auth` schema. The supabase/postgres image ships both roles without a
    // usable password; like Supabase's own setup, set one. Fake, per-run values.
    const authenticatorPassword = randomBytes(18).toString("hex");
    const authAdminPassword = randomBytes(18).toString("hex");
    setRolePassword(stack.pg, "authenticator", authenticatorPassword);
    setRolePassword(stack.pg, "supabase_auth_admin", authAdminPassword);

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
    docker([
      "run",
      "--detach",
      "--name",
      authContainer,
      "--label",
      LABEL,
      "--network",
      network,
      "--env",
      "GOTRUE_API_HOST=0.0.0.0",
      "--env",
      "PORT=9999",
      "--env",
      "API_EXTERNAL_URL=http://127.0.0.1:9999",
      "--env",
      "GOTRUE_SITE_URL=http://127.0.0.1:3000",
      "--env",
      "GOTRUE_DB_DRIVER=postgres",
      "--env",
      `GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:${authAdminPassword}@${PG_NETWORK_ALIAS}:5432/postgres`,
      "--env",
      `GOTRUE_JWT_SECRET=${jwtSecret}`,
      "--env",
      "GOTRUE_JWT_EXP=3600",
      "--env",
      "GOTRUE_JWT_AUD=authenticated",
      "--env",
      "GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
      "--env",
      "GOTRUE_JWT_ADMIN_ROLES=service_role",
      // Invite-only, as the app expects (G7): users come from the admin API.
      "--env",
      "GOTRUE_DISABLE_SIGNUP=true",
      "--env",
      "GOTRUE_EXTERNAL_EMAIL_ENABLED=true",
      "--env",
      "GOTRUE_MAILER_AUTOCONFIRM=false",
      "--env",
      "GOTRUE_EXTERNAL_PHONE_ENABLED=false",
      "--publish",
      "127.0.0.1::9999",
      GOTRUE_IMAGE,
    ]);

    stack.gateway = await startGateway({
      "/rest/v1": publishedPort(restContainer, "3000"),
      "/auth/v1": publishedPort(authContainer, "9999"),
    });
    stack.url = `http://127.0.0.1:${(stack.gateway.address() as AddressInfo).port}`;
    await Promise.all([
      waitForRest(stack.url, stack.serviceRoleKey, timeoutMs),
      waitForAuth(stack.url, timeoutMs),
    ]);
    return stack;
  } catch (error) {
    const logs = [restContainer, authContainer].map((container) => {
      const run = spawnSync("docker", ["logs", "--tail", "30", container], { encoding: "utf8" });
      return `${container}:\n${run.stdout ?? ""}${run.stderr ?? ""}`;
    });
    await removeRestStack(stack);
    throw new Error(`${String(error)}\n${logs.join("\n")}`);
  }
}

/** Removes the three containers, the network and the gateway. Safe to call twice. */
export async function removeRestStack(stack: RestStack | undefined): Promise<void> {
  if (!stack) return;
  if (stack.gateway?.listening) {
    stack.gateway.closeAllConnections();
    await new Promise((resolvePromise) => stack.gateway?.close(() => resolvePromise(undefined)));
  }
  spawnSync("docker", ["rm", "--force", "--volumes", stack.restContainer, stack.authContainer], {
    encoding: "utf8",
  });
  if (stack.pg.name) removePgContainer(stack.pg);
  spawnSync("docker", ["network", "rm", stack.network], { encoding: "utf8" });
}
