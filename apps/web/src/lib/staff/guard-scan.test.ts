import { describe, expect, it } from "vitest";
import { scanStaffGuards, type GuardException, type SourceFile } from "./guard-scan";

// The scanner behind the static test (P5-T16 criterion 6). Its rules are pure,
// so a fake file list proves the rule, and guard-static.test.ts proves the real
// tree. A file under app/staff that answers a request must call requireStaff,
// unless it is one of the short, named public endpoints.
const exceptions: GuardException[] = [
  { path: "src/app/staff/login/page.tsx", reason: "public sign-in screen" },
  { path: "src/app/staff/login/route.ts", reason: "sign-in endpoint" },
  { path: "src/app/staff/logout/route.ts", reason: "sign-out endpoint" },
  { path: "src/app/staff/session-ended/route.ts", reason: "denial endpoint" },
];

function file(path: string, body: string): SourceFile {
  return { path, body };
}

describe("scanStaffGuards", () => {
  it("accepts a page that calls requireStaff", () => {
    const result = scanStaffGuards(
      [file("src/app/staff/tickets/page.tsx", "await requireStaff();")],
      [],
    );
    expect(result).toEqual({ missing: [], staleExceptions: [], undocumented: [] });
  });

  it("reports a page that does not call requireStaff", () => {
    const result = scanStaffGuards(
      [file("src/app/staff/tickets/page.tsx", "export default 1")],
      [],
    );
    expect(result.missing).toEqual(["src/app/staff/tickets/page.tsx"]);
  });

  it.each([
    "// await requireStaff()",
    "/* await requireStaff() */",
    'const help = "await requireStaff()";',
    "function requireStaff() {}",
    "requireStaff();",
  ])("refuses text or an unawaited call as guard proof: %s", (body) => {
    const path = "src/app/staff/tickets/page.tsx";
    expect(scanStaffGuards([file(path, body)], []).missing).toEqual([path]);
  });

  it("finds a server-action directive after a comment", () => {
    const path = "src/app/staff/actions.ts";
    const body = '/* actions */\n"use server";\nexport async function submit() {}';
    expect(scanStaffGuards([file(path, body)], []).missing).toEqual([path]);
  });

  it.each([
    "export async function guarded() { await requireStaff(); } export async function open() {}",
    "export const guarded = async () => { await requireStaff(); }; export const open = async () => {};",
    "export async function open() { const unused = async () => { await requireStaff(); }; }",
  ])("requires a guard in each exported handler, not an unused helper", (handlers) => {
    const path = "src/app/staff/actions.ts";
    expect(scanStaffGuards([file(path, '"use server";\n' + handlers)], []).missing).toEqual([path]);
  });

  it("reports an action with no guard", () => {
    const result = scanStaffGuards(
      [file("src/app/staff/tickets/actions.ts", '"use server";\nexport const a = 1;')],
      [],
    );
    expect(result.missing).toEqual(["src/app/staff/tickets/actions.ts"]);
  });

  it("accepts a documented public endpoint", () => {
    const result = scanStaffGuards(
      [file("src/app/staff/login/page.tsx", "export default 1")],
      exceptions,
    );
    expect(result.missing).toEqual([]);
  });

  it("reports an exception whose file is gone", () => {
    const result = scanStaffGuards([], [exceptions[0]!]);
    expect(result.staleExceptions).toEqual(["src/app/staff/login/page.tsx"]);
  });

  it("reports an exception with no reason", () => {
    const result = scanStaffGuards(
      [file("src/app/staff/login/page.tsx", "export default 1")],
      [{ path: "src/app/staff/login/page.tsx", reason: " " }],
    );
    expect(result.undocumented).toEqual(["src/app/staff/login/page.tsx"]);
  });

  it("ignores files that do not answer a request", () => {
    const result = scanStaffGuards(
      [file("src/app/staff/login/login-form.tsx", '"use client";\nexport const x = 1;')],
      [],
    );
    expect(result.missing).toEqual([]);
  });
});
