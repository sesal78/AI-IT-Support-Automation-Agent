/**
 * The static guard rule (P5-T16 criterion 6): every file under `app/staff` that
 * answers a request (a page, route or layout) or is a server action must call
 * `requireStaff`, unless it is a named public endpoint with a written reason.
 * Pure, so the rule is tested without touching the tree.
 */
export interface SourceFile {
  path: string;
  body: string;
}

export interface GuardException {
  path: string;
  reason: string;
}

export interface GuardScanResult {
  /** Request-answering files that neither call the guard nor hold an exception. */
  missing: string[];
  /** Exceptions whose file no longer exists. */
  staleExceptions: string[];
  /** Exceptions with no written reason. */
  undocumented: string[];
}

const GUARD_CALL = /requireStaff\s*\(/;
const ANSWERS_A_REQUEST = /\/(page|route|layout)\.tsx?$/;
const SERVER_ACTION = /^\s*["']use server["']/;

export function scanStaffGuards(
  files: SourceFile[],
  exceptions: GuardException[],
): GuardScanResult {
  const known = new Set(files.map((file) => file.path));
  const exempt = new Set(exceptions.map((entry) => entry.path));

  const missing = files
    .filter((file) => ANSWERS_A_REQUEST.test(file.path) || SERVER_ACTION.test(file.body))
    .filter((file) => !exempt.has(file.path))
    .filter((file) => !GUARD_CALL.test(file.body))
    .map((file) => file.path);

  return {
    missing,
    staleExceptions: exceptions.map((entry) => entry.path).filter((path) => !known.has(path)),
    undocumented: exceptions
      .filter((entry) => entry.reason.trim() === "")
      .map((entry) => entry.path),
  };
}
