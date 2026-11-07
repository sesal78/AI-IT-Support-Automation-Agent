// Entry point of `pnpm verify:personas`. Run with Node's type stripping; the
// orchestrator supplies the env through the approved key-store loader.
import { errorClassName } from "./client.ts";
import { runVerifyPersonas } from "./verify-personas.ts";

try {
  process.exitCode = await runVerifyPersonas(process.env, {
    fetch: (input, init) => fetch(input, init),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
} catch (error) {
  process.stderr.write(`verify:personas: error (${errorClassName(error)})\n`);
  process.exitCode = 2;
}
