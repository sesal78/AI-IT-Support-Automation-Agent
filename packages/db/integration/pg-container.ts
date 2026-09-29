import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

// Pinned test image. Must match the major version of the Dokploy `db`
// container, which runs Postgres 17 (confirmed in phase 1 step H4).
export const SUPABASE_POSTGRES_IMAGE = "supabase/postgres:17.6.1.177";

// Every container this harness creates carries this name prefix and label,
// so it can be told apart from anything else running on the machine.
export const CONTAINER_PREFIX = "itsupport-it-";
const LABEL = "itsupport-it=true";

export interface PgContainer {
  name: string;
  port: number;
  password: string;
}

export interface SqlRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

export function clientFor(container: PgContainer): pg.Client {
  return new pg.Client({
    host: "127.0.0.1",
    port: container.port,
    user: "postgres",
    password: container.password,
    database: "postgres",
  });
}

async function waitUntilReady(container: PgContainer, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = clientFor(container);
    // A refused or reset connection emits "error"; swallow it and retry.
    client.on("error", () => undefined);
    try {
      await client.connect();
      // The image creates the Supabase roles during init; wait for them.
      const { rowCount } = await client.query(
        "select 1 from pg_roles where rolname = 'service_role'",
      );
      if (rowCount === 1) return;
    } catch (error) {
      lastError = error;
    } finally {
      await client.end().catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const logs = spawnSync("docker", ["logs", "--tail", "50", container.name], { encoding: "utf8" });
  throw new Error(
    `container ${container.name} not ready after ${timeoutMs} ms: ${String(lastError)}\n${logs.stdout}${logs.stderr}`,
  );
}

/** Starts a throwaway supabase/postgres container bound to 127.0.0.1 only. */
export async function startPgContainer(timeoutMs = 180_000): Promise<PgContainer> {
  const name = `${CONTAINER_PREFIX}${randomBytes(4).toString("hex")}`;
  // Fake, per-run password: this database only lives for one test run.
  const password = randomBytes(18).toString("hex");
  const container: PgContainer = { name, port: 0, password };
  try {
    docker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      LABEL,
      "--env",
      `POSTGRES_PASSWORD=${password}`,
      "--publish",
      "127.0.0.1::5432",
      SUPABASE_POSTGRES_IMAGE,
    ]);
    const mapping = docker(["port", name, "5432/tcp"]).split(/\r?\n/)[0] ?? "";
    const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping);
    if (!match?.[1]) throw new Error(`unexpected port mapping for ${name}: "${mapping}"`);
    container.port = Number(match[1]);
    await waitUntilReady(container, timeoutMs);
    return container;
  } catch (error) {
    removePgContainer(container);
    throw error;
  }
}

/** Removes the container and its anonymous volumes. Safe to call twice. */
export function removePgContainer(container: PgContainer | undefined): void {
  if (!container) return;
  spawnSync("docker", ["rm", "--force", "--volumes", container.name], { encoding: "utf8" });
}

/** Runs SQL with psql inside the container, in one transaction, stopping on the first error. */
export function runSql(container: PgContainer, sql: string): SqlRun {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "--interactive",
      "--env",
      `PGPASSWORD=${container.password}`,
      container.name,
      "psql",
      "--host=127.0.0.1",
      "--username=postgres",
      "--dbname=postgres",
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--single-transaction",
      "--file=-",
    ],
    { input: sql, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
