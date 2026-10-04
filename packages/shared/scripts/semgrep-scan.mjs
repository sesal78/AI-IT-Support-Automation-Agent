// Runs the Semgrep OSS CLI from a pinned Docker image (root script
// `pnpm scan:semgrep`), so the same command works locally and in CI. With no
// argument it scans the repo. `pnpm scan:semgrep -- <folder>` scans one folder
// inside the repo on its own, without the repo's .semgrepignore (the self-test
// fixtures need this). Exits with Semgrep's own code (1 = findings), or 2 when
// the scan could not run. Needs Docker, and network for the image and rules.
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Exact version tag plus its digest. Change both together.
const image =
  "semgrep/semgrep:1.178.0@sha256:32e459968daabe7ab86968184a29109b9564aa00392401156f9788452b42786b";
const rulePacks = ["p/typescript", "p/nextjs", "p/secrets", "p/owasp-top-ten"];

function fail(message) {
  console.error(`scan:semgrep: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length > 1) fail(`expected at most one folder, got ${args.length} arguments`);
const scanRoot = resolve(args[0] ?? repoRoot);
const inRepo = relative(repoRoot, scanRoot);
const outside = inRepo === ".." || inRepo.startsWith(`..${sep}`) || isAbsolute(inRepo);
if (outside || !statSync(scanRoot, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`target "${args[0]}" is not an existing folder inside the repo`);
}

const daemon = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
  encoding: "utf8",
});
if (daemon.error || daemon.status !== 0) {
  const detail = (daemon.error?.message ?? daemon.stderr).trim();
  fail(`Docker is needed to run Semgrep, and no Docker daemon is reachable: ${detail}`);
}

// The scan root is mounted read-only at /src, the image's working directory.
const dockerRun = ["run", "--rm", "--volume", `${scanRoot}:/src:ro`, "--workdir", "/src", image];
// Only ERROR findings fail the scan. No usage data is sent to Semgrep.
const flags = ["--error", "--severity", "ERROR", "--metrics=off", "--disable-version-check"];
const scan = spawnSync(
  "docker",
  [
    ...dockerRun,
    ...["semgrep", "scan", ...rulePacks.flatMap((pack) => ["--config", pack]), ...flags, "."],
  ],
  { stdio: "inherit" },
);
if (scan.error) fail(`Docker is needed to run Semgrep: ${scan.error.message}`);
process.exit(scan.status ?? 2);
