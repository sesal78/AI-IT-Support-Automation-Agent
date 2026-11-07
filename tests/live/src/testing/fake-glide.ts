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

export function createFakeInstance(roles: readonly string[] = ["snc_internal", "itil", "admin"]) {
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
      this.matches = this.rows.filter((r) => this.filters.every(([f, v]) => r[f] === v));
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
      this.current()[field] = String(value);
    }
    insert() {
      const row = addRow(this.table, { ...this.draft });
      writes.push({ op: "insert", table: this.table, row: { ...row } });
      this.matches = [row];
      this.at = 0;
      return row["sys_id"];
    }
    update() {
      writes.push({ op: "update", table: this.table, row: { ...this.current() } });
    }
    deleteRecord() {
      const row = this.current();
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
    addRow,
    roleId,
    /** Runs the script; `mailbox` replaces the REPLY_MAILBOX line, like Seun's edit. */
    run(mailbox = ""): string[] {
      const source = readFileSync(SEED_SCRIPT, "utf8").replace(
        /var REPLY_MAILBOX = ".*";/,
        `var REPLY_MAILBOX = ${JSON.stringify(mailbox)};`,
      );
      lines.length = 0;
      runInNewContext(source, { GlideRecord, gs: { print: (line: string) => lines.push(line) } });
      return [...lines];
    },
  };
}
