// Entry point of `pnpm scan:traces` and `pnpm scan:logs`. Run with Node's type
// stripping; the orchestrator supplies the Langfuse keys by env name.
import { errorClassName } from "./client.ts";
import { runScan } from "./scan.ts";

try {
  process.exitCode = await runScan(process.argv.slice(2), process.env, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
} catch (error) {
  // Never print an unknown error's message: it may quote a value.
  process.stderr.write(`scan: error (${errorClassName(error)})\n`);
  process.exitCode = 2;
}
