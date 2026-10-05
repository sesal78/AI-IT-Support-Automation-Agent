import { statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

// Guard modules (redaction, policy, internal-API auth, idempotency) carry
// floors above the global coverage floor. The list is the root
// guard-modules.json. This file reads the disk, so index.ts does not export it
// (the web client bundle imports index.ts).

// A plain repo-relative file path: forward slashes, at least one folder, no
// glob characters and no `.` or `..` segment. Vitest reads a threshold key as
// a glob on the root-relative path and skips a key that matches no file.
export const REPO_PATH = /^[\w-][\w.-]*(\/[\w-][\w.-]*)+$/;

const guardModuleSchema = z.strictObject({
  path: z.string().regex(REPO_PATH, "must be a repo-relative file path with forward slashes"),
  /** Statement coverage floor in percent. */
  statements: z.number().min(90),
  /** Mutation score floor in percent; null until it is switched on. */
  mutation: z.number().min(80).nullable(),
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

/** The listed paths that are not a file under `repoRoot`. */
export function missingGuardModules(list: ReadonlyArray<GuardModule>, repoRoot: string): string[] {
  return list
    .map((module) => module.path)
    .filter((path) => !statSync(resolve(repoRoot, path), { throwIfNoEntry: false })?.isFile());
}
