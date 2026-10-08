import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, createGzip, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildCanaries } from "../src/canaries.js";
import { createEgressRecorder } from "../test-support/egress-recorder.js";

const recorder = createEgressRecorder();
const RUN = recorder.runId;
const ORIGIN = "https://api.typesafe.ai";
const URL_SYSTEMONE = `${ORIGIN}/v1/systemone`;
const canary = (type: string): string => {
  const found = buildCanaries(RUN).find((entry) => entry.type === type);
  if (!found) throw new Error(`no canary of type ${type}`);
  return found.value;
};

function leakMessage(): string {
  try {
    recorder.assertClean();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("assertClean did not throw");
}

const post = (body: RequestInit["body"], init: RequestInit = {}, url = URL_SYSTEMONE) =>
  fetch(url, { method: "POST", body, ...init });

beforeAll(() => {
  recorder.start();
  recorder.mock(ORIGIN);
});
afterEach(() => recorder.reset());
afterAll(() => recorder.stop());

describe("egress recorder: what counts as a leak", () => {
  it("names the host and the type for an email canary, never the value", async () => {
    await post(JSON.stringify({ text: `mail ${canary("email")} please` }));
    const message = leakMessage();
    expect(message).toContain("api.typesafe.ai");
    expect(message).toContain("email");
    expect(message).not.toContain(canary("email"));
    expect(message).not.toContain(RUN);
  });

  it("passes a body with only a placeholder and plain words", async () => {
    await post(JSON.stringify({ text: "Reply to [REDACTED_EMAIL] about the VPN" }));
    expect(() => recorder.assertClean()).not.toThrow();
  });

  it("catches a canary in the query string, a header value and a gzip body", async () => {
    await post("{}", {}, `${URL_SYSTEMONE}?q=${encodeURIComponent(canary("ssn"))}`);
    await post("{}", { headers: { "x-note": canary("api_key") } });
    await post(gzipSync(Buffer.from(`card ${canary("card")}`)), {
      headers: { "content-encoding": "gzip" },
    });
    const message = leakMessage();
    expect(message).toContain("query: ssn");
    expect(message).toContain("header x-note: api_key");
    expect(message).toContain("body: card");
    for (const type of ["ssn", "api_key", "card"]) expect(message).not.toContain(canary(type));
  });

  it("catches a registered string as custom#1", async () => {
    recorder.forbid("Dana Example");
    await post(JSON.stringify({ text: "ticket from dana example" }));
    expect(leakMessage()).toContain("custom#1");
  });

  it("catches a raw email that is not a canary as unredacted:EMAIL", async () => {
    await post(JSON.stringify({ text: "mail jo@x.com" }));
    const message = leakMessage();
    expect(message).toContain("unredacted:EMAIL");
    expect(message).not.toContain("jo@x.com");
  });

  it("rejects an empty string for forbid()", () => {
    expect(() => recorder.forbid("")).toThrow(TypeError);
  });

  it("checks an extra run ID passed to assertClean", async () => {
    const other = buildCanaries("other1").find((entry) => entry.type === "password")?.value ?? "";
    await post(other);
    expect(() => recorder.assertClean()).not.toThrow();
    expect(() => recorder.assertClean("other1")).toThrow(/password/);
    expect(() => recorder.assertClean("BAD!")).toThrow(TypeError);
  });
});

describe("egress recorder: hosts", () => {
  it("blocks an un-mocked host, names it, and makes no real call", async () => {
    const res = await fetch("https://unmocked.invalid/x");
    // The caller gets a failed response that names the host...
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("unmocked.invalid");
    // ...and the clean check fails too, even if the SDK swallows that response.
    expect(leakMessage()).toContain("unmocked.invalid");
    recorder.reset();
    expect(() => recorder.assertClean()).not.toThrow();
  });

  it("treats localhost and [::1] as un-mocked (only 127.0.0.1 passes)", async () => {
    expect((await fetch("https://localhost:9/")).status).toBe(500);
    expect((await fetch("https://[::1]:9/")).status).toBe(500);
    const message = leakMessage();
    expect(message).toContain("localhost:9");
    expect(message).toContain("[::1]:9");
  });

  describe("127.0.0.1", () => {
    let server: Server;
    let base = "";
    beforeAll(async () => {
      server = createServer((_req, res) => res.end("local-ok"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it("passes through and is not recorded, even with a canary in it", async () => {
      const res = await post(canary("email"), {}, base);
      expect(await res.text()).toBe("local-ok");
      expect(recorder.requests()).toHaveLength(0);
      expect(() => recorder.assertClean()).not.toThrow();
    });
  });
});

describe("egress recorder: recording", () => {
  it("records method, host, path, query, headers and body, but never authorization", async () => {
    await post(
      '{"a":1}',
      {
        headers: {
          authorization: "Bearer not-a-real-token",
          cookie: "sid=abc",
          "x-api-key": "k",
          "x-keep": "yes",
        },
      },
      `${URL_SYSTEMONE}?x=1`,
    );
    const [entry] = recorder.requests();
    expect(entry).toMatchObject({
      method: "POST",
      host: "api.typesafe.ai",
      path: "/v1/systemone",
      query: "?x=1",
      body: '{"a":1}',
    });
    expect(entry?.headers).toMatchObject({
      "x-keep": "yes",
      cookie: "[omitted]",
      "x-api-key": "[omitted]",
    });
    expect(entry?.headers).not.toHaveProperty("authorization");
    expect(JSON.stringify(entry)).not.toContain("not-a-real-token");
  });

  it("still scans authorization, cookie and x-api-key for canaries", async () => {
    await post("{}", {
      headers: {
        authorization: `Bearer ${canary("github_token")}`,
        cookie: `s=${canary("password")}`,
        "x-api-key": canary("aws_key"),
      },
    });
    const message = leakMessage();
    for (const type of ["github_token", "password", "aws_key"]) expect(message).toContain(type);
    expect(JSON.stringify(recorder.requests())).not.toContain(canary("password"));
  });
});

describe("egress recorder: attack list", () => {
  it("catches an upper-case email canary", async () => {
    await post(canary("email").toUpperCase());
    expect(leakMessage()).toContain("body: email");
  });

  it("catches an email inside the URL path and a percent-encoded %40 email", async () => {
    await post("{}", {}, `${ORIGIN}/v1/users/jo@x.com/profile`);
    await post(`to=${encodeURIComponent(canary("email"))}`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    await post("{}", {}, `${ORIGIN}/v1/u?m=jo%40x.com`);
    const message = leakMessage();
    expect(message).toContain("path: unredacted:EMAIL");
    expect(message).toContain("body: email");
    expect(message).toContain("query: unredacted:EMAIL");
  });

  it("catches a JSON-escaped email and a multipart body", async () => {
    await post('{"to":"jo\\u0040x.com"}');
    await post(
      `--b\r\nContent-Disposition: form-data; name="t"\r\n\r\n${canary("phone")}\r\n--b--`,
      { headers: { "content-type": "multipart/form-data; boundary=b" } },
    );
    const message = leakMessage();
    expect(message).toContain("body: unredacted:EMAIL");
    expect(message).toContain("body: phone");
  });

  it("catches a card canary with its spaces removed", async () => {
    await post(canary("card").replaceAll(" ", ""));
    expect(leakMessage()).toContain("body: card");
  });

  it("catches a canary split across gzip chunks", async () => {
    const value = canary("password");
    const gzip = createGzip();
    const parts: Buffer[] = [];
    gzip.on("data", (chunk: Buffer) => parts.push(chunk));
    const done = new Promise<void>((resolve) => gzip.on("end", resolve));
    gzip.write(value.slice(0, 6));
    gzip.flush();
    gzip.write(value.slice(6));
    gzip.end();
    await done;
    await post(Buffer.concat(parts), { headers: { "content-encoding": "gzip" } });
    expect(leakMessage()).toContain("body: password");
  });

  it("unpacks deflate, raw deflate, br and a gzip body without a header", async () => {
    const text = Buffer.from(`x ${canary("ssn")}`);
    await post(deflateSync(text), { headers: { "content-encoding": "deflate" } });
    await post(deflateRawSync(text), { headers: { "content-encoding": "deflate" } });
    await post(brotliCompressSync(text), { headers: { "content-encoding": "br" } });
    await post(gzipSync(text));
    const hits = leakMessage()
      .split("\n")
      .filter((line) => line.includes("body: ssn"));
    expect(hits).toHaveLength(4);
    expect(recorder.requests()).toHaveLength(4);
    for (const entry of recorder.requests()) expect(entry.body).toContain("x ");
  });

  it("fails closed on an encoding it cannot read", async () => {
    await post("plain", { headers: { "content-encoding": "zstd" } });
    await post(Buffer.from("not gzip"), { headers: { "content-encoding": "gzip" } });
    const message = leakMessage();
    expect(message.match(/fail closed/g)).toHaveLength(2);
  });

  it("handles an empty body and a binary body without a false alarm", async () => {
    await post(null);
    await post(new Uint8Array([0, 255, 128, 7, 200, 1, 2, 3]));
    expect(() => recorder.assertClean()).not.toThrow();
    expect(recorder.requests()).toHaveLength(2);
  });

  it("scans a 5 MB body fast, clean and with a canary at the very end", async () => {
    const filler = "a".repeat(5 * 1024 * 1024);
    let started = performance.now();
    await post(filler);
    expect(() => recorder.assertClean()).not.toThrow();
    expect(performance.now() - started).toBeLessThan(5000);
    recorder.reset();
    started = performance.now();
    await post(filler + canary("email"));
    expect(leakMessage()).toContain("body: email");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("is intercepted when the SDK uses node:https instead of fetch", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest(URL_SYSTEMONE, { method: "POST" }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end(`mail ${canary("email")}`);
    });
    expect(leakMessage()).toContain("body: email");
  });
});
