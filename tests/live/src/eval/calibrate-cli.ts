// Entry point of `pnpm eval:calibrate`. Run with Node type stripping; the
// orchestrator supplies the env through the approved key-store loader.
import { fileURLToPath } from "node:url";
import { errorClassName } from "../client.ts";
import { runCalibrate } from "./calibrate.ts";

const root = new URL("../../../../", import.meta.url);

try {
  process.exitCode = await runCalibrate({
    argv: process.argv.slice(2),
    env: process.env,
    judgesDir: fileURLToPath(new URL("evals/judges", root)),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
} catch (error) {
  process.stderr.write(`eval:calibrate: harness error (${errorClassName(error)})\n`);
  process.exitCode = 2;
}
