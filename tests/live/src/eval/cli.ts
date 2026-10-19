// Entry point of `pnpm eval`. Run with Node's type stripping; the orchestrator
// supplies the env through the approved key-store loader.
import { fileURLToPath } from "node:url";
import { errorClassName } from "../client.ts";
import { runEval } from "./run.ts";

const root = new URL("../../../../", import.meta.url);

try {
  process.exitCode = await runEval({
    argv: process.argv.slice(2),
    env: process.env,
    datasetPath: fileURLToPath(new URL("evals/tickets.json", root)),
    evidenceDir: fileURLToPath(new URL(".loop-evidence", root)),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
} catch (error) {
  // Never print an unknown error's message: it may quote a value.
  process.stderr.write(`eval: harness error (${errorClassName(error)})\n`);
  process.exitCode = 2;
}
