// Entry point of `pnpm test:live`. Run with Node's type stripping; the
// orchestrator supplies the env through the approved key-store loader.
import { fileURLToPath } from "node:url";
import { errorClassName } from "./client.ts";
import { runLive } from "./runner.ts";
import { scenarios } from "./scenarios.ts";

const evidenceDir = fileURLToPath(new URL("../../../.loop-evidence", import.meta.url));

try {
  process.exitCode = await runLive({
    argv: process.argv.slice(2),
    env: process.env,
    scenarios,
    evidenceDir,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
} catch (error) {
  // Never print an unknown error's message: it may quote a value.
  process.stderr.write(`live: harness error (${errorClassName(error)})\n`);
  process.exitCode = 2;
}
