import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildParams,
  createServiceNowClient,
  isLookupSafeEmail,
  sysIdParam,
  ticketIdParam,
  userLookupParams,
} from "../src/index.js";

const ORIGIN = "https://example.service-now.com";

function recordingClient() {
  const urls: string[] = [];
  const fetchMock = vi.fn((url: string | URL | Request) => {
    urls.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify({ result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  const client = createServiceNowClient({
    instanceUrl: ORIGIN,
    username: "svc.itsupport",
    password: "unit-test-password-1",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, urls, fetchMock };
}

// T5.U.02
describe("T5.U.02 caller lookup encoding", () => {
  it.each([
    "a^b@x.com",
    "x@y.com^ORactive=true",
    "x@y.com\r\nX: 1",
    "x@y.com,z@y.com",
    "x@y.com\u0000",
    "a=b@x.com",
    " x@y.com",
    "x@y",
    "@y.com",
    "x y@z.com",
    "x@y.com'",
    "",
  ])("%j is refused and sends no request", async (email) => {
    expect(isLookupSafeEmail(email)).toBe(false);
    const { client, fetchMock } = recordingClient();
    await expect(
      (async () => client.get("sys_user", userLookupParams(email)))(),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 5, ["a@b.com"]])("the non-string %j is refused", (value) => {
    expect(isLookupSafeEmail(value)).toBe(false);
  });

  it.each(["ünï@exämple.com", "demo.carol@example.com", "e2e-load+3@example.com"])(
    "%s gives one request whose only data-bearing parameter is email",
    async (email) => {
      expect(isLookupSafeEmail(email)).toBe(true);
      const { client, urls } = recordingClient();
      await client.get("sys_user", userLookupParams(email));
      expect(urls).toHaveLength(1);
      const url = new URL(urls[0] as string);
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname).toBe("/api/now/table/sys_user");
      expect(url.searchParams.has("sysparm_query")).toBe(false);
      expect([...url.searchParams.keys()].sort()).toEqual([
        "active",
        "email",
        "sysparm_fields",
        "sysparm_limit",
      ]);
      expect(url.searchParams.get("email")).toBe(email);
      expect(url.searchParams.get("active")).toBe("true");
      expect(url.searchParams.get("sysparm_fields")).toBe("sys_id");
      expect(url.searchParams.get("sysparm_limit")).toBe("2");
      // The raw URL holds the value percent-encoded, never as raw syntax.
      expect(urls[0]).toContain(`email=${encodeURIComponent(email).replace(/%20/g, "+")}`);
    },
  );

  it("buildParams refuses ^, =, controls and reserved or odd names, without echoing", () => {
    const fields = ["sys_id"];
    for (const value of ["a^b", "a=b", "a\nb", "a\u0000b", "a\u007fb"]) {
      let error: unknown;
      try {
        buildParams({ filters: { email: value }, fields });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).not.toContain(value);
    }
    for (const name of ["sysparm_query", "a^b", "Email", "a=b", "", "1a"]) {
      expect(() => buildParams({ filters: { [name]: "x" }, fields })).toThrow(TypeError);
    }
    expect(() => buildParams({ fields: ["sys_id^ORx"] })).toThrow(TypeError);
    expect(() => buildParams({ fields, limit: 0 })).toThrow(TypeError);
    expect(() => buildParams({ fields, limit: 101 })).toThrow(TypeError);
    expect(() => buildParams({ fields, limit: 1.5 })).toThrow(TypeError);
  });

  it("a filter value is one percent-encoded parameter", () => {
    const params = buildParams({ filters: { name: "a&b c%20" }, fields: ["sys_id", "name"] });
    expect(params.toString()).toBe("name=a%26b+c%2520&sysparm_fields=sys_id%2Cname");
  });

  it("a plain get sends only sysparm_fields and the default sysparm_limit", async () => {
    const { client, urls } = recordingClient();
    await client.get("sys_user_group", { fields: ["sys_id", "name"] });
    const url = new URL(urls[0] as string);
    expect([...url.searchParams.keys()].sort()).toEqual(["sysparm_fields", "sysparm_limit"]);
    expect(url.searchParams.get("sysparm_limit")).toBe("10");
  });
});

describe("id parameters", () => {
  it("ticketIdParam accepts a UUID only", () => {
    const id = randomUUID();
    expect(ticketIdParam(id)).toBe(id);
    expect(ticketIdParam(id.toUpperCase())).toBe(id);
    for (const bad of ["x' OR 1=1", "ITS-000001", "", `${id}x`, undefined, 7]) {
      expect(() => ticketIdParam(bad)).toThrow(TypeError);
    }
  });

  it("sysIdParam accepts 32 lower-case hex only", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(sysIdParam(id)).toBe(id);
    for (const bad of ["../incident", id.toUpperCase(), id.slice(1), `${id}0`, "", undefined]) {
      expect(() => sysIdParam(bad)).toThrow(TypeError);
    }
  });

  it("the thrown messages do not echo the value", () => {
    expect(() => ticketIdParam("x' OR 1=1")).toThrow(/^(?!.*OR 1=1)/);
    expect(() => sysIdParam("../incident")).toThrow(/^(?!.*incident)/);
  });

  it("an invalid sys_id or table name throws before any request", async () => {
    const { client, fetchMock } = recordingClient();
    await expect(client.patch("incident", "../incident", { state: 2 })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(client.get("incident/../x", { fields: ["number"] })).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(client.post("Incident", {}, ["number"])).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
