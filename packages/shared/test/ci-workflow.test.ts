import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowPath = resolve(repoRoot, ".github/workflows/ci.yml");

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface Job {
  uses?: string;
  needs?: string | string[];
  steps?: Step[];
}

interface Workflow {
  name?: string;
  on?: Record<string, { branches?: string[] } | null>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, Job>;
}

// One job per docs/PROJECT.md §9 gate, and the command it must run.
const gateCommands: Record<string, string> = {
  lint: "pnpm lint",
  format: "pnpm format:check",
  typecheck: "pnpm typecheck",
  test: "pnpm test -- --coverage",
  build: "pnpm build",
  audit: "pnpm audit --audit-level critical",
  gitleaks: "gitleaks git",
  integration: "pnpm test:integration",
  e2e: "pnpm test:e2e",
  docker: "pnpm test:e2e:docker",
};

// `owner/repo[/path]@<full 40-hex commit SHA>`. Tags, branches, short SHAs,
// local actions and docker:// references are all rejected.
const pinnedRef = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_./-]+)?@[0-9a-f]{40}$/;

function isPinned(ref: string): boolean {
  return pinnedRef.test(ref);
}

function load(): Workflow {
  return parse(readFileSync(workflowPath, "utf8")) as Workflow;
}

function allUses(workflow: Workflow): string[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => [
    ...(job.uses ? [job.uses] : []),
    ...(job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
  ]);
}

function runScript(job: Job | undefined): string {
  return (job?.steps ?? []).map((step) => step.run ?? "").join("\n");
}

describe("pin check", () => {
  it("accepts a full commit SHA", () => {
    expect(isPinned("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1")).toBe(true);
    expect(isPinned("github/codeql-action/init@3d3c42e5aac5ba805825da76410c181273ba90b1")).toBe(
      true,
    );
  });

  it("rejects tags, branches, short SHAs and non-repo references", () => {
    for (const ref of [
      "actions/checkout@v7",
      "actions/checkout@v7.0.1",
      "actions/checkout@main",
      "actions/checkout@3d3c42e",
      "actions/checkout@3D3C42E5AAC5BA805825DA76410C181273BA90B1",
      "actions/checkout",
      "./.github/actions/setup",
      "docker://alpine:3",
    ]) {
      expect(isPinned(ref), ref).toBe(false);
    }
  });
});

describe(".github/workflows/ci.yml", () => {
  it("exists", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  it("is named ci", () => {
    expect(load().name).toBe("ci");
  });

  it("runs on pushes and pull requests to dev and main only", () => {
    const on = load().on ?? {};
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push"]);
    expect([...(on.push?.branches ?? [])].sort()).toEqual(["dev", "main"]);
    expect([...(on.pull_request?.branches ?? [])].sort()).toEqual(["dev", "main"]);
  });

  it("grants only read access to repository contents", () => {
    expect(load().permissions).toEqual({ contents: "read" });
  });

  it("cancels superseded runs", () => {
    expect(load().concurrency?.["cancel-in-progress"]).toBe(true);
  });

  it("has a separate job for each gate, running the gate command", () => {
    const jobs = load().jobs ?? {};
    for (const [gate, command] of Object.entries(gateCommands)) {
      expect(jobs[gate], `job ${gate}`).toBeDefined();
      expect(runScript(jobs[gate]), `job ${gate}`).toContain(command);
    }
  });

  it("has a ci job that needs every gate job", () => {
    const needs = load().jobs?.ci?.needs ?? [];
    expect([...(Array.isArray(needs) ? needs : [needs])].sort()).toEqual(
      Object.keys(gateCommands).sort(),
    );
  });

  it("uses at least one action", () => {
    expect(allUses(load()).length).toBeGreaterThan(0);
  });

  it("pins every action to a full commit SHA", () => {
    const unpinned = allUses(load()).filter((ref) => !isPinned(ref));
    expect(unpinned).toEqual([]);
  });

  it("labels every pinned SHA with its release tag", () => {
    const lines = readFileSync(workflowPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => /^\s*(-\s+)?uses:/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\s*$/);
    }
  });

  it("scans the full git history for secrets with a checksum-verified gitleaks", () => {
    const job = load().jobs?.gitleaks;
    const checkout = (job?.steps ?? []).find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(runScript(job)).toMatch(/sha256sum (--check|-c)/);
  });
});
