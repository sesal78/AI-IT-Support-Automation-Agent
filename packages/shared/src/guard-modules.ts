import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Guard modules (redaction, policy, internal-API auth, idempotency) carry
// floors above the global coverage floor. The list is the root
// guard-modules.json. This file reads the disk, so index.ts does not export it
// (the web client bundle imports index.ts).

// A plain repo-relative file path: forward slashes, at least one folder, no
// glob characters and no `.` or `..` segment. Vitest reads a threshold key as
// a glob on the root-relative path and skips a key that matches no file.
export const REPO_PATH = /^[\w-][\w.-]*(\/[\w-][\w.-]*)+$/;

const repoPath = z
  .string()
  .regex(REPO_PATH, "must be a repo-relative file path with forward slashes");

const guardModuleSchema = z.strictObject({
  path: repoPath,
  /** Statement coverage floor in whole percent. */
  statements: z.int().min(90).max(100),
  /** Mutation score floor in whole percent; null until it is switched on. */
  mutation: z.int().min(80).max(100).nullable(),
  /** Other test files that kill the module's mutants; a change to one re-runs the mutation gate. */
  tests: z
    .array(repoPath.regex(/\.test\.tsx?$/, "must be a .test.ts or .test.tsx file"))
    .min(1)
    .refine((tests) => new Set(tests).size === tests.length, "duplicate test")
    .optional(),
  /**
   * false: each mutant runs only the module's own test file and its `tests`,
   * not every test that imports it (keeps a large module inside CI's time limit).
   */
  related: z.literal(false).optional(),
});

const guardModulesSchema = z.array(guardModuleSchema).superRefine((list, ctx) => {
  list.forEach(({ path }, index) => {
    if (list.findIndex((other) => other.path === path) !== index) {
      ctx.addIssue({ code: "custom", path: [index, "path"], message: "duplicate path" });
    }
  });
});

export type GuardModule = z.infer<typeof guardModuleSchema>;

/** Thrown when the guard-module list is invalid. The message names each bad entry by its path. */
export class GuardModulesError extends Error {
  constructor(problems: string[]) {
    super(`Invalid guard-modules.json:\n${problems.map((line) => `  ${line}`).join("\n")}`);
    this.name = "GuardModulesError";
  }
}

const withPath = z.looseObject({ path: z.string() });

/** Validates the parsed content of guard-modules.json. */
export function parseGuardModules(json: unknown): GuardModule[] {
  const result = guardModulesSchema.safeParse(json);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const [index, ...field] = issue.path;
    const entry = withPath.safeParse(Array.isArray(json) ? json[Number(index)] : undefined);
    const position = index === undefined ? "(root)" : `entry ${String(index)}`;
    const name = entry.success ? entry.data.path : position;
    return [name, ...field.map(String), issue.message].join(": ");
  });
  throw new GuardModulesError(problems);
}

/** One Vitest per-file coverage threshold for each guard module, keyed by its path. */
export function coverageThresholds(
  list: ReadonlyArray<GuardModule>,
): Record<string, { statements: number }> {
  return Object.fromEntries(list.map(({ path, statements }) => [path, { statements }]));
}

/**
 * The listed paths, modules and their tests, that are not a file under `repoRoot`.
 * Each segment must equal a directory entry name exactly, so a wrong-case path
 * is missing on a case-insensitive file system too (it would match no coverage key).
 */
export function missingGuardModules(list: ReadonlyArray<GuardModule>, repoRoot: string): string[] {
  return list
    .flatMap(({ path, tests = [] }) => [path, ...tests])
    .filter((path) => !isExactFile(repoRoot, path.split("/")));
}

function isExactFile(dir: string, [name, ...rest]: string[]): boolean {
  if (name === undefined) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const entry = entries.find((candidate) => candidate.name === name);
  if (entry === undefined) return false;
  if (rest.length === 0) return entry.isFile();
  return entry.isDirectory() && isExactFile(join(dir, name), rest);
}
