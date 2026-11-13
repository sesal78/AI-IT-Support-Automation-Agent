/**
 * The static guard rule (P5-T16 criterion 6): every file under `app/staff` that
 * answers a request (a page, route or layout) or is a server action must call
 * `requireStaff`, unless it is a named public endpoint with a written reason.
 * Pure, so the rule is tested without touching the tree.
 */
import ts from "typescript";

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

const ANSWERS_A_REQUEST = /\/(page|route|layout)\.tsx?$/;

function callsGuard(node: ts.Node): boolean {
  if (
    ts.isAwaitExpression(node) &&
    ts.isCallExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "requireStaff"
  )
    return true;
  // A helper defined inside a handler does not guard the handler itself.
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, callsGuard) ?? false;
}

function protectedSource(file: SourceFile) {
  const source = ts.createSourceFile(
    file.path,
    file.body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const first = source.statements[0];
  const action =
    first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server";
  const bodies: ts.Node[] = [];
  for (const statement of source.statements) {
    if (
      !ts.canHaveModifiers(statement) ||
      !ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (ts.isFunctionDeclaration(statement) && statement.body) bodies.push(statement.body);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const value = declaration.initializer;
        if (value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value)))
          bodies.push(value.body);
      }
    }
  }
  return {
    answers: ANSWERS_A_REQUEST.test(file.path) || action,
    guarded: bodies.length ? bodies.every(callsGuard) : callsGuard(source),
  };
}

export function scanStaffGuards(
  files: SourceFile[],
  exceptions: GuardException[],
): GuardScanResult {
  const known = new Set(files.map((file) => file.path));
  const exempt = new Set(exceptions.map((entry) => entry.path));

  const missing = files
    .filter((file) => !exempt.has(file.path))
    .filter((file) => {
      const checked = protectedSource(file);
      return checked.answers && !checked.guarded;
    })
    .map((file) => file.path);

  return {
    missing,
    staleExceptions: exceptions.map((entry) => entry.path).filter((path) => !known.has(path)),
    undocumented: exceptions
      .filter((entry) => entry.reason.trim() === "")
      .map((entry) => entry.path),
  };
}
