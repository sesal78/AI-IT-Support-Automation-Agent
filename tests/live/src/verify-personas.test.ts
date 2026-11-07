import { describe, expect, it } from "vitest";
import { runVerifyPersonas } from "./verify-personas.ts";
import {
  fullInstance,
  mockServiceNow,
  SN_PASSWORD,
  SN_URL,
  SN_USER,
  type MockSnData,
} from "./testing/mock-servicenow.ts";

const env = {
  E2E_SERVICENOW_INSTANCE_URL: SN_URL,
  E2E_SERVICENOW_USERNAME: SN_USER,
  E2E_SERVICENOW_PASSWORD: SN_PASSWORD,
};

async function verify(
  data: MockSnData,
  source: Record<string, string | undefined> = env,
  options: { denyRoles?: boolean; denyAll?: number } = {},
) {
  const mock = mockServiceNow(data, options);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runVerifyPersonas(source, {
    fetch: mock.fetch,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  });
  return { code, out, err, mock };
}

const idOf = (data: MockSnData, name: string) =>
  data.users.find((u) => u["user_name"] === name)!["sys_id"]!;

describe("verify:personas", () => {
  it("verify exits 0 against a mock instance with everything present, and only reads", async () => {
    const { code, out, err, mock } = await verify(fullInstance());
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual(["ok: all personas, categories and groups present"]);
    expect(mock.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("verify exits non-zero and names a missing persona", async () => {
    const data = fullInstance();
    data.users = data.users.filter((u) => u["user_name"] !== "demo.dave");
    const { code, out } = await verify(data);
    expect(code).toBe(1);
    expect(out).toContain("missing demo.dave: missing");
  });

  it("verify exits non-zero and names demo.frank when it lacks itil", async () => {
    const data = fullInstance();
    data.roles[idOf(data, "demo.frank")] = ["snc_internal"];
    const { code, out } = await verify(data);
    expect(code).toBe(1);
    expect(out).toEqual(["missing demo.frank: lacks itil"]);
  });

  it("verify names an extra role on a persona", async () => {
    const data = fullInstance();
    data.roles[idOf(data, "demo.alice")] = ["snc_internal", "admin"];
    expect((await verify(data)).out).toEqual(["missing demo.alice: extra role admin"]);
  });

  it("verify exits non-zero and names demo.gina when it is active", async () => {
    const data = fullInstance();
    data.users.find((u) => u["user_name"] === "demo.gina")!["active"] = "true";
    const { code, out } = await verify(data);
    expect(code).toBe(1);
    expect(out).toEqual(["missing demo.gina: active"]);
  });

  it("verify exits non-zero and names a missing category", async () => {
    const data = fullInstance();
    data.categories = data.categories.filter((c) => c !== "password_reset");
    const { code, out } = await verify(data);
    expect(code).toBe(1);
    expect(out).toEqual(["missing category password_reset: missing"]);
  });

  it("verify exits non-zero and names a missing group", async () => {
    const data = fullInstance();
    data.groups = data.groups.filter((g) => g !== "IT Securities");
    const { code, out } = await verify(data);
    expect(code).toBe(1);
    expect(out).toEqual(["missing group IT Securities: missing"]);
  });

  it("verify names abel.tuter when it is missing and svc.itsupport when it holds more than itil", async () => {
    const data = fullInstance();
    data.users = data.users.filter((u) => u["user_name"] !== "abel.tuter");
    data.roles[idOf(data, "svc.itsupport")] = ["itil", "admin"];
    const { code, out } = await verify(data);
    expect(code).toBe(1);
    expect(out).toEqual([
      "missing abel.tuter: missing",
      "missing svc.itsupport: roles not only itil",
    ]);
  });

  it("verify reports a refused read as not_checked (exit 2), never as a pass, and stops there", async () => {
    const { code, out, mock } = await verify(fullInstance(), env, { denyRoles: true });
    expect(code).toBe(2);
    expect(out).toEqual([
      "not_checked demo.alice",
      "stopped: a read was refused, the remaining items were not asked",
    ]);
    expect(out.join(" ")).not.toContain("ok:");
    // userByName worked, userRoles was refused, and nothing was asked after that.
    expect(mock.requests).toHaveLength(2);
  });

  it.each([401, 403])(
    "verify stops after the first %i: one request, not_checked, exit 2",
    async (status) => {
      const { code, out, mock } = await verify(fullInstance(), env, { denyAll: status });
      expect(code).toBe(2);
      expect(mock.requests).toHaveLength(1);
      expect(out[0]).toBe("not_checked demo.alice");
    },
  );

  it("verify keeps a missing item found before the refusal and exits 1", async () => {
    const data = fullInstance();
    data.users = data.users.filter((u) => u["user_name"] !== "demo.alice");
    const { code, out } = await verify(data, env, { denyRoles: true });
    expect(code).toBe(1);
    expect(out[0]).toBe("missing demo.alice: missing");
    expect(out).toContain("not_checked demo.bob");
  });

  it("verify with the variables unset runs nothing and exits 2, naming them", async () => {
    const { code, err, mock } = await verify(fullInstance(), {});
    expect(code).toBe(2);
    expect(err[0]).toContain("E2E_SERVICENOW_INSTANCE_URL");
    expect(mock.requests).toEqual([]);
  });

  it("verify with a bad instance URL fails naming the variable, and holds no marker in any output", async () => {
    const bad = { ...env, E2E_SERVICENOW_INSTANCE_URL: "https://other.service-now.com" };
    const { code, out, err, mock } = await verify(fullInstance(), bad);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("E2E_SERVICENOW_INSTANCE_URL");
    expect(mock.requests).toEqual([]);
    expect([...out, ...err].join("\n")).not.toContain(SN_PASSWORD);
  });

  it("verify: with the password set to a marker, no stdout or stderr holds it, even when a call fails", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runVerifyPersonas(env, {
      fetch: async () => new Response(`${SN_PASSWORD}`, { status: 500 }),
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("ServiceNowApiError");
    expect([...out, ...err].join("\n")).not.toContain(SN_PASSWORD);
  });
});
