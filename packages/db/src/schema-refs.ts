// Lightweight SQL scanning for migration review. It is not a full SQL parser:
// it finds the schemas a migration names so a test can keep this project
// inside its own schema on the shared Supabase stack.

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;

// `schema.name` (the part before the dot is the schema). The lookbehind skips
// the middle of a longer dotted chain and parts of other identifiers/numbers.
const QUALIFIED = new RegExp(String.raw`(?<![\w$."])(${IDENT})\s*\.\s*${IDENT}`, "g");

// `schema <name>` clauses: create/drop/alter schema, `with schema`, `in schema`, `on schema`.
const SCHEMA_CLAUSE = new RegExp(
  String.raw`\bschema\s+(?:if\s+(?:not\s+)?exists\s+)?(${IDENT})`,
  "gi",
);

// Objects that take their own schema (indexes and triggers follow their table).
const CREATE_OBJECT = new RegExp(
  String.raw`\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary|unlogged)\s+)?` +
    String.raw`(?:table|view|materialized\s+view|function|procedure|sequence|type|domain)\s+` +
    String.raw`(?:if\s+not\s+exists\s+)?(${IDENT})(\s*\.\s*${IDENT})?`,
  "gi",
);

/**
 * Blanks out comments, string literals and dollar-quote tags, keeping quoted
 * identifiers and the code inside dollar-quoted bodies (e.g. function bodies).
 */
function stripNonCode(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    const lineComment = /^--[^\n]*/.exec(rest);
    const blockComment = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest);
    // Backslash escapes only exist in E'' strings (standard_conforming_strings).
    const escapeString = /[\w$]$/.test(out) ? null : /^[eE]'(?:''|\\.|[^'\\])*(?:'|$)/.exec(rest);
    const stringLiteral = escapeString ?? /^'(?:''|[^'])*(?:'|$)/.exec(rest);
    const dollarTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    const quotedIdent = /^"(?:[^"]|"")*"/.exec(rest);
    const blank = lineComment ?? blockComment ?? stringLiteral ?? dollarTag;
    if (blank) {
      out += " ";
      i += blank[0].length;
    } else if (quotedIdent) {
      out += quotedIdent[0];
      i += quotedIdent[0].length;
    } else {
      out += sql.charAt(i);
      i += 1;
    }
  }
  return out;
}

function normalize(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident.toLowerCase();
}

/** Returns the sorted, de-duplicated schema names a SQL script refers to. */
export function referencedSchemas(sql: string): string[] {
  const code = stripNonCode(sql);
  const schemas = new Set<string>();
  for (const match of code.matchAll(QUALIFIED)) schemas.add(normalize(match[1] as string));
  for (const match of code.matchAll(SCHEMA_CLAUSE)) schemas.add(normalize(match[1] as string));
  return [...schemas].sort();
}

/** Returns created object names that have no schema, so would land in the search_path. */
export function unqualifiedCreates(sql: string): string[] {
  const code = stripNonCode(sql);
  return [...code.matchAll(CREATE_OBJECT)]
    .filter((match) => match[2] === undefined)
    .map((match) => match[1] as string);
}
