import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { scanStaffGuards, type GuardException, type SourceFile } from "./guard-scan";

// The real-tree half of P5-T16 criterion 6: no page, route, layout or server
// action under app/staff may answer a request without `requireStaff` unless it
// is one of these named public endpoints. The list is pinned below, so a new
// file fails this test until it is guarded or added here with a reason.
const STAFF_ROOT = join(process.cwd(), "src", "app", "staff");

const PUBLIC_ENDPOINTS: GuardException[] = [
  { path: "src/app/staff/login/page.tsx", reason: "public sign-in screen (G7, invite-only)" },
  { path: "src/app/staff/login/route.ts", reason: "sign-in endpoint; answers 400/401/429 itself" },
  {
    path: "src/app/staff/logout/route.ts",
    reason: "sign-out must work for a stale or non-staff session; a guard would block it",
  },
  {
    path: "src/app/staff/session-ended/route.ts",
    reason: "the denial endpoint clears the session and answers 403; a guard would loop",
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function staffFiles(): SourceFile[] {
  const root = join(process.cwd());
  return walk(STAFF_ROOT).map((full) => ({
    path: relative(root, full).replaceAll("\\", "/"),
    body: readFileSync(full, "utf8"),
  }));
}

describe("staff guard coverage", () => {
  it("has a requireStaff call on every request-answering staff file", () => {
    expect(scanStaffGuards(staffFiles(), PUBLIC_ENDPOINTS)).toEqual({
      missing: [],
      staleExceptions: [],
      undocumented: [],
    });
  });

  it("pins the request-answering files, so a new one cannot slip in unguarded", () => {
    const answering = staffFiles()
      .map((file) => file.path)
      .filter((path) => /\/(page|route|layout)\.tsx?$/.test(path))
      .sort();
    expect(answering).toEqual([
      "src/app/staff/login/page.tsx",
      "src/app/staff/login/route.ts",
      "src/app/staff/logout/route.ts",
      "src/app/staff/session-ended/route.ts",
    ]);
  });

  it("keeps every public endpoint documented", () => {
    for (const entry of PUBLIC_ENDPOINTS) expect(entry.reason.trim()).not.toBe("");
  });
});
