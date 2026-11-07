// A fake ServiceNow server side for seed-personas.js: GlideRecord over in-memory
// tables, gs.print, and a log of every write (P5-T7). Run with node:vm.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Row = Record<string, string>;
export interface WriteLog {
  readonly op: "insert" | "update" | "delete";
  readonly table: string;
  readonly row: Row;
}

export const SEED_SCRIPT = new URL(
  "../../../../scripts/servicenow/seed-personas.js",
  import.meta.url,
);

export interface FakeOptions {
  readonly roles?: readonly string[];
  /** Tables whose addQuery filters are ignored, so every row matches (a broken or unscoped query). */
  readonly ignoreFilters?: readonly string[];
}

export function createFakeInstance(options: FakeOptions = {}) {
  const roles = options.roles ?? ["snc_internal", "itil", "admin"];
  const ignored = new Set(options.ignoreFilters ?? []);
  // Every attempted write to a row that is not a demo.* user, or to a role row of such a user.
  const violations: string[] = [];
  const tables: Record<string, Row[]> = { sys_user: [], sys_user_has_role: [], sys_user_role: [] };
  const writes: WriteLog[] = [];
  const lines: string[] = [];
  let counter = 0;
  const newId = () => String(++counter).padStart(32, "0");
  const addRow = (table: string, row: Row): Row => {
    const full = { sys_id: newId(), ...row };
    tables[table]!.push(full);
    return full;
  };
  for (const name of roles) addRow("sys_user_role", { name });

  class GlideRecord {
    private readonly rows: Row[];
    private isDemoOwner(row: Row): boolean {
      if (this.table === "sys_user") return (row["user_name"] ?? "").startsWith("demo.");
      if (this.table !== "sys_user_has_role") return true;
      const owner = tables["sys_user"]!.find((u) => u["sys_id"] === row["user"]);
      return (owner?.["user_name"] ?? "").startsWith("demo.");
    }
    /** Throws, and records it, when a write would reach a row that is not a demo.* user's. */
    private guardWrite(op: string, row: Row): void {
      if (this.isDemoOwner(row)) return;
      violations.push(`${op} ${this.table} ${row["sys_id"] ?? row["user"] ?? "new"}`);
      throw new Error(`FAKE: unscoped ${op} of ${this.table}`);
    }
    private filters: Array<[string, string]> = [];
    private matches: Row[] = [];
    private at = -1;
    private draft: Row = {};
    private readonly table: string;
    constructor(table: string) {
      this.table = table;
      this.rows = tables[table]!;
    }
    addQuery(field: string, value: string) {
      this.filters.push([field, value]);
    }
    query() {
      this.matches = this.rows.filter(
        (r) => ignored.has(this.table) || this.filters.every(([f, v]) => r[f] === v),
      );
      this.at = -1;
    }
    next() {
      this.at += 1;
      return this.at < this.matches.length;
    }
    initialize() {
      this.draft = {};
      this.at = -1;
      this.matches = [];
    }
    private current(): Row {
      return this.at >= 0 ? this.matches[this.at]! : this.draft;
    }
    getValue(field: string) {
      return this.current()[field] ?? null;
    }
    getUniqueValue() {
      return this.current()["sys_id"];
    }
    setValue(field: string, value: unknown) {
      // A found sys_user row is checked on every field set; a draft or role row is checked on write.
      if (this.at >= 0 && this.table === "sys_user") this.guardWrite("set", this.current());
      this.current()[field] = String(value);
    }
    insert() {
      this.guardWrite("insert", this.draft);
      const row = addRow(this.table, { ...this.draft });
      writes.push({ op: "insert", table: this.table, row: { ...row } });
      this.matches = [row];
      this.at = 0;
      return row["sys_id"];
    }
    update() {
      this.guardWrite("update", this.current());
      writes.push({ op: "update", table: this.table, row: { ...this.current() } });
    }
    deleteRecord() {
      const row = this.current();
      this.guardWrite("delete", row);
      writes.push({ op: "delete", table: this.table, row: { ...row } });
      tables[this.table]!.splice(tables[this.table]!.indexOf(row), 1);
    }
  }

  const roleId = (name: string) =>
    tables["sys_user_role"]!.find((r) => r["name"] === name)!["sys_id"]!;
  return {
    tables,
    writes,
    lines,
    violations,
    addRow,
    roleId,
    /** Runs the script; `mailbox` replaces the REPLY_MAILBOX line, like Seun's edit. */
    run(mailbox = "", script = readFileSync(SEED_SCRIPT, "utf8")): string[] {
      const source = script.replace(
        /var REPLY_MAILBOX = ".*";/,
        `var REPLY_MAILBOX = ${JSON.stringify(mailbox)};`,
      );
      lines.length = 0;
      runInNewContext(source, { GlideRecord, gs: { print: (line: string) => lines.push(line) } });
      return [...lines];
    },
  };
}
