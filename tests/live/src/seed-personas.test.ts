import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeInstance, SEED_SCRIPT } from "./testing/fake-glide.ts";

const NAMES = ["alice", "bob", "carol", "dave", "erin", "frank", "gina"];
const source = readFileSync(SEED_SCRIPT, "utf8");
type Fake = ReturnType<typeof createFakeInstance>;

function userRow(fake: Fake, userName: string) {
  return fake.tables["sys_user"]!.find((r) => r["user_name"] === userName)!;
}

function rolesOf(fake: Fake, userName: string): string[] {
  const user = userRow(fake, userName);
  return fake.tables["sys_user_has_role"]!.filter((r) => r["user"] === user["sys_id"])
    .map((r) => fake.tables["sys_user_role"]!.find((x) => x["sys_id"] === r["role"])!["name"]!)
    .sort();
}

const unchanged = NAMES.map((n) => `unchanged demo.${n}`);

describe("seed-personas.js (node:vm, fake GlideRecord)", () => {
  it("seed first run: creates 7 users with the section 4.2 roles and active values", () => {
    const fake = createFakeInstance();
    expect(fake.run()).toEqual(NAMES.map((n) => `created demo.${n}`));
    for (const n of NAMES) {
      const user = userRow(fake, `demo.${n}`);
      expect(user["email"]).toBe(`demo.${n}@example.com`);
      expect(user["active"]).toBe(n === "gina" ? "false" : "true");
      expect(user["locked_out"]).toBe("false");
      expect(user["first_name"]).toBeTruthy();
      expect(user["last_name"]).toBeTruthy();
      const roles = n === "frank" ? ["itil", "snc_internal"] : ["snc_internal"];
      expect(rolesOf(fake, `demo.${n}`)).toEqual(roles);
    }
  });

  it("seed second run: changes nothing and prints unchanged 7 times", () => {
    const fake = createFakeInstance();
    fake.run();
    fake.writes.length = 0;
    expect(fake.run()).toEqual(unchanged);
    expect(fake.writes).toEqual([]);
  });

  it("seed removes an extra admin role from demo.alice and restores a missing itil on demo.frank", () => {
    const fake = createFakeInstance();
    fake.run();
    fake.addRow("sys_user_has_role", {
      user: userRow(fake, "demo.alice")["sys_id"]!,
      role: fake.roleId("admin"),
    });
    const rows = fake.tables["sys_user_has_role"]!;
    const frankId = userRow(fake, "demo.frank")["sys_id"];
    rows.splice(
      rows.findIndex((r) => r["user"] === frankId && r["role"] === fake.roleId("itil")),
      1,
    );
    const lines = fake.run();
    expect(lines[0]).toBe("updated demo.alice");
    expect(lines[5]).toBe("updated demo.frank");
    expect(rolesOf(fake, "demo.alice")).toEqual(["snc_internal"]);
    expect(rolesOf(fake, "demo.frank")).toEqual(["itil", "snc_internal"]);
  });

  it("seed never writes abel.tuter or another non-demo user, and leaves inherited rows alone", () => {
    const fake = createFakeInstance();
    const abel = fake.addRow("sys_user", { user_name: "abel.tuter", email: "a@b.c" });
    const near = fake.addRow("sys_user", { user_name: "demo2.x", email: "x@y.z" });
    fake.addRow("sys_user_has_role", { user: abel["sys_id"]!, role: fake.roleId("admin") });
    fake.addRow("sys_user_has_role", { user: near["sys_id"]!, role: fake.roleId("admin") });
    fake.run();
    fake.addRow("sys_user_has_role", {
      user: userRow(fake, "demo.alice")["sys_id"]!,
      role: fake.roleId("itil"),
      inherited: "true",
    });
    fake.writes.length = 0;
    expect(fake.run()).toEqual(unchanged);
    expect(fake.writes).toEqual([]);
    expect(abel["email"]).toBe("a@b.c");
    expect(rolesOf(fake, "abel.tuter")).toEqual(["admin"]);
    expect(rolesOf(fake, "demo2.x")).toEqual(["admin"]);
  });

  it("seed with REPLY_MAILBOX set changes only demo.carol's email", () => {
    const fake = createFakeInstance();
    fake.run();
    fake.writes.length = 0;
    const lines = fake.run("seun@example.org");
    expect(lines.filter((l) => l.startsWith("updated"))).toEqual(["updated demo.carol"]);
    expect(lines.filter((l) => l.startsWith("unchanged"))).toHaveLength(6);
    expect(fake.writes.map((w) => w.row["user_name"])).toEqual(["demo.carol"]);
    expect(userRow(fake, "demo.carol")["email"]).toBe("seun@example.org");
    expect(userRow(fake, "demo.alice")["email"]).toBe("demo.alice@example.com");
    expect(fake.run("seun@example.org")).toEqual(unchanged);
  });

  it("seed refuses a bad REPLY_MAILBOX before any write", () => {
    const fake = createFakeInstance();
    const lines = fake.run("not an address");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^error: REPLY_MAILBOX/);
    expect(fake.writes).toEqual([]);
  });

  it("seed stops before any write when a role is missing on the instance", () => {
    const fake = createFakeInstance(["snc_internal"]);
    expect(() => fake.run()).toThrow(/role itil does not exist/);
    expect(fake.writes).toEqual([]);
  });

  it("seed output carries no password or token text", () => {
    expect(createFakeInstance().run().join("\n")).not.toMatch(/password|token/i);
  });
});

describe("seed-personas.js (static)", () => {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("static: every insert(), update() and deleteRecord() sits in a function that first calls requireDemo", () => {
    const headers = [...code.matchAll(/function (\w+)\s*\([^)]*\)\s*\{/g)];
    const writes = [...code.matchAll(/\.(insert|update|deleteRecord)\(\)/g)];
    expect(writes.length).toBeGreaterThanOrEqual(4);
    for (const write of writes) {
      const header = headers.filter((h) => h.index! < write.index!).at(-1)!;
      const body = code.slice(header.index! + header[0].length);
      expect(body.trimStart().startsWith("requireDemo("), `${write[0]} in ${header[1]}`).toBe(true);
    }
  });

  it("static: requireDemo rejects any name without the demo. prefix, and every persona is demo.*", () => {
    expect(code).toMatch(/indexOf\(PREFIX\) !== 0\) \{\s*throw/);
    expect(code).toMatch(/var PREFIX = "demo\.";/);
    const names = [...code.matchAll(/\{ name: "(\w+)", roles/g)].map((m) => m[1]);
    expect(names).toEqual(NAMES);
  });

  it("static: the script sets no password field and is ES5", () => {
    expect(code).not.toMatch(/password/i);
    expect(code).not.toMatch(/=>|\blet\b|\bconst\b|`/);
  });
});
