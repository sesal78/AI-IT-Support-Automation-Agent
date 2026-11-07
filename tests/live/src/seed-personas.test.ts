import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakeInstance, SEED_SCRIPT } from "./testing/fake-glide.ts";

const NAMES = ["alice", "bob", "carol", "dave", "erin", "frank", "gina"];
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
    const fake = createFakeInstance({ roles: ["snc_internal"] });
    expect(() => fake.run()).toThrow(/role itil does not exist/);
    expect(fake.writes).toEqual([]);
  });

  it("seed output carries no password or token text", () => {
    expect(createFakeInstance().run().join("\n")).not.toMatch(/password|token/i);
  });
});

// A stock-looking user the seed script must never write.
function addAbel(fake: Fake) {
  return fake.addRow("sys_user", {
    user_name: "abel.tuter",
    first_name: "Abel",
    last_name: "Tuter",
    email: "abel.tuter@example.com",
    active: "true",
    locked_out: "true",
  });
}

const SCRIPT = readFileSync(SEED_SCRIPT, "utf8");
// The guard in saveUser, and the exact-match check after it, as the script spells them.
const SAVE_GUARD =
  /requireDemo\(isNew \? PREFIX \+ persona\.name : user\.getValue\("user_name"\)\);/;
const SAVE_EXACT =
  /if \(!isNew && String\(user\.getValue\("user_name"\)\) !== [^\n]*\{\s*throw [^\n]*\s*\}/;
const LOOP =
  'var all = new GlideRecord("sys_user"); all.query(); while (all.next()) { all.setValue("active", false); all.update(); }';
const TOP_LOOP_MUTANT = `${SCRIPT}\n${LOOP}`;

describe("seed-personas.js (unscoped queries)", () => {
  it("seed with the sys_user filter ignored writes nothing to abel.tuter and stops with an error", () => {
    const fake = createFakeInstance({ ignoreFilters: ["sys_user"] });
    const abel = addAbel(fake);
    const before = { ...abel };
    expect(() => fake.run()).toThrow(/not a demo|not the persona expected/);
    expect(fake.violations).toEqual([]);
    expect(fake.writes).toEqual([]);
    expect(abel).toEqual(before);
  });

  it("seed with the sys_user filter ignored and a demo user first still writes nothing", () => {
    const fake = createFakeInstance({ ignoreFilters: ["sys_user"] });
    fake.addRow("sys_user", { user_name: "demo.zed", email: "z@example.com", active: "true" });
    addAbel(fake);
    expect(() => fake.run()).toThrow(/not a demo|not the persona expected/);
    expect(fake.violations).toEqual([]);
    expect(fake.writes).toEqual([]);
  });

  it("seed with the role filter ignored deletes no role row of another user and stops with an error", () => {
    const fake = createFakeInstance({ ignoreFilters: ["sys_user_has_role"] });
    const abel = addAbel(fake);
    const admin = fake.addRow("sys_user_has_role", {
      user: abel["sys_id"]!,
      role: fake.roleId("admin"),
    });
    expect(() => fake.run()).toThrow(/role row of another user/);
    expect(fake.violations).toEqual([]);
    expect(fake.tables["sys_user_has_role"]).toContain(admin);
  });

  it("seed does not run the role query with an empty user id", () => {
    const fake = createFakeInstance();
    const source = SCRIPT.replace("var newId = user.insert();", 'user.insert(); var newId = "";');
    expect(source).not.toBe(SCRIPT);
    expect(() => fake.run("", source)).toThrow(/new user was not saved/);
    expect(fake.tables["sys_user_has_role"]).toEqual([]);
  });

  it("seed with a plain run records no violation, and abel.tuter keeps every field", () => {
    const fake = createFakeInstance();
    const abel = addAbel(fake);
    const before = { ...abel };
    fake.run();
    expect(fake.violations).toEqual([]);
    expect(abel).toEqual(before);
  });
});

// The scope rule the static test enforces: every insert(), update() and deleteRecord() sits
// in a function (the anonymous one included) whose first statement is requireDemo(...) with
// an argument that reads the record's own user_name. Braces are tracked, strings blanked.
function unguardedWrites(script: string): string[] {
  const blankOut = (m: string) => " ".repeat(m.length);
  const text = script.replace(/\/\*[\s\S]*?\*\//g, blankOut).replace(/\/\/[^\n]*/g, blankOut);
  const blank = text.replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => `"${"_".repeat(m.length - 2)}"`);
  const functions: Array<{ open: number; end: number; name: string }> = [];
  for (const match of blank.matchAll(/function\s*(\w*)\s*\([^)]*\)\s*\{/g)) {
    const open = match.index! + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < blank.length; i++) {
      if (blank[i] === "{") depth++;
      if (blank[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    functions.push({ open, end, name: match[1] || "(anonymous)" });
  }
  const bad: string[] = [];
  for (const write of blank.matchAll(/\.(insert|update|deleteRecord)\(\)/g)) {
    const at = write.index!;
    const inner = functions
      .filter((f) => f.open < at && at < f.end)
      .sort((a, b) => b.open - a.open)[0];
    if (inner === undefined) {
      bad.push(`${write[0]} outside any function`);
      continue;
    }
    const body = text.slice(inner.open + 1, inner.end).trimStart();
    const guard = /^requireDemo\(([^;]*)\);/.exec(body);
    if (guard === null || !/getValue\("user_name"\)/.test(guard[1]!)) {
      bad.push(`${write[0]} in ${inner.name}`);
    }
  }
  return bad;
}

const stripComments = (c: string) =>
  c.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const TRAILING_COMMA = /,\s*[)\]}]/;
const NEWER_JS =
  /\.(includes|startsWith|endsWith|padStart|padEnd|find|findIndex|flat|flatMap|at)\(|Object\.(assign|entries|values|fromEntries)|Array\.from|\.\.\./;

describe("seed-personas.js (static)", () => {
  const code = stripComments(SCRIPT);

  it("static: every insert(), update() and deleteRecord() sits in a function that first guards the record's own user_name", () => {
    expect([...code.matchAll(/\.(insert|update|deleteRecord)\(\)/g)].length).toBeGreaterThanOrEqual(
      4,
    );
    expect(unguardedWrites(SCRIPT)).toEqual([]);
  });

  it("static: requireDemo rejects any name without the demo. prefix, and every persona is demo.*", () => {
    expect(code).toMatch(/indexOf\(PREFIX\) !== 0\) \{\s*throw/);
    expect(code).toMatch(/var PREFIX = "demo\.";/);
    const names = [...code.matchAll(/\{ name: "(\w+)", roles/g)].map((m) => m[1]);
    expect(names).toEqual(NAMES);
  });

  it("static: the script sets no password field", () => {
    expect(code).not.toMatch(/password/i);
  });

  it("static: the script is ES5 (no newer syntax or methods, no trailing commas)", () => {
    expect(code).not.toMatch(/=>|\blet\b|\bconst\b|`/);
    expect(code).not.toMatch(NEWER_JS);
    expect(code).not.toMatch(TRAILING_COMMA);
  });
});

describe("seed-personas.js (mutants are caught)", () => {
  it("mutant: no guard before the writes in saveUser is caught by the static check and by an unscoped run", () => {
    const mutant = SCRIPT.replace(SAVE_GUARD, "").replace(SAVE_EXACT, "");
    expect(mutant).not.toBe(SCRIPT);
    expect(unguardedWrites(mutant)).toContain(".update() in saveUser");
    const fake = createFakeInstance({ ignoreFilters: ["sys_user"] });
    addAbel(fake);
    expect(() => fake.run("", mutant)).toThrow(/FAKE: unscoped/);
    expect(fake.violations.length).toBeGreaterThan(0);
  });

  it("mutant: a top-level loop that sets active=false on every sys_user row is caught", () => {
    expect(unguardedWrites(TOP_LOOP_MUTANT)).toEqual([".update() outside any function"]);
    const fake = createFakeInstance();
    addAbel(fake);
    expect(() => fake.run("", TOP_LOOP_MUTANT)).toThrow(/FAKE: unscoped/);
    expect(fake.violations.length).toBeGreaterThan(0);
  });

  it("mutant: the same loop inside the anonymous function is caught", () => {
    const inside = SCRIPT.replace(/\}\)\(\);\s*$/, `${LOOP} })();`);
    expect(inside).not.toBe(SCRIPT);
    expect(unguardedWrites(inside)).toEqual([".update() in (anonymous)"]);
  });

  it("mutant: a tautological guard requireDemo(PREFIX) is caught", () => {
    const mutant = SCRIPT.replace(SAVE_GUARD, "requireDemo(PREFIX);");
    expect(mutant).not.toBe(SCRIPT);
    expect(unguardedWrites(mutant)).toEqual([".insert() in saveUser", ".update() in saveUser"]);
  });

  it("mutant: the ES5 checks catch .includes, a trailing comma and Object.assign", () => {
    expect(stripComments(`${SCRIPT}\nx.includes("a");`)).toMatch(NEWER_JS);
    expect(stripComments(`${SCRIPT}\nObject.assign(a, b);`)).toMatch(NEWER_JS);
    expect(stripComments(SCRIPT.replace("locked_out: false", "locked_out: false,"))).toMatch(
      TRAILING_COMMA,
    );
  });
});
