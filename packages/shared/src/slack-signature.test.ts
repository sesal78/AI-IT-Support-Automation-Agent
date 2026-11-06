import { beforeEach, describe, expect, it, vi } from "vitest";

const createHmac = vi.hoisted(() => vi.fn());
const timingSafeEqual = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  createHmac.mockImplementation(actual.createHmac);
  timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, createHmac, timingSafeEqual };
});

const { signSlackRequest, verifySlackRequest } = await import("./slack-signature.js");
const index = await import("./index.js");

// Test secrets are assembled at run time so no secret-shaped literal lands in
// the repo (gitleaks runs in CI). All values are fake.
const SECRET = ["fake", "Slack", "Signing", "Secret", "0123456789"].join("");
const NOW = 1_700_000_000;
const BODY = "payload=%7B%22type%22%3A%22block_actions%22%7D";

type Headers_ = Parameters<typeof verifySlackRequest>[0]["headers"];

function signed(body = BODY, timestamp = String(NOW), secret = SECRET) {
  return {
    "x-slack-signature": signSlackRequest({ secret, timestamp, body }),
    "x-slack-request-timestamp": timestamp,
  };
}
function verify(headers: Headers_, body = BODY, nowSeconds = NOW, secret = SECRET) {
  return verifySlackRequest({ secret, headers, body, nowSeconds });
}
const bad = (reason: string) => ({ ok: false, reason });

beforeEach(() => {
  createHmac.mockClear();
  timingSafeEqual.mockClear();
});

describe("signSlackRequest", () => {
  it("returns v0= plus the lower-case hex HMAC-SHA256 of v0:<timestamp>:<body>", () => {
    const signature = signSlackRequest({ secret: SECRET, timestamp: "123", body: "a=b" });
    expect(signature).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(createHmac).toHaveBeenCalledWith("sha256", SECRET);
  });

  it("is exported from the package index, as is the verifier", () => {
    expect(index.signSlackRequest).toBe(signSlackRequest);
    expect(index.verifySlackRequest).toBe(verifySlackRequest);
  });

  it.each([
    ["empty", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
  ])("throws a TypeError naming secret for a %s secret", (_, secret) => {
    expect(() => signSlackRequest({ secret: secret as never, timestamp: "1", body: "" })).toThrow(
      new TypeError("secret must be a non-empty string"),
    );
    expect(createHmac).not.toHaveBeenCalled();
  });
});

describe("known answer (Slack's 'Verifying requests from Slack' example)", () => {
  // Copied from the Slack docs page at build time (2026-10-25); the secret is
  // split so secret scanners do not flag it, and so is the token in the body.
  const secret = ["8f742231b10e8888", "abcd99yyyzzz85a5"].join("");
  const timestamp = "1531420618";
  const body = [
    "token=",
    "xyzz0WbapA4vBCDEFasx0q6G",
    "&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar",
    "&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=",
    "&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN",
    "&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
  ].join("");
  const signature = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";

  it("signs to the published signature", () => {
    expect(signSlackRequest({ secret, timestamp, body })).toBe(signature);
  });

  it("verifies the published request", () => {
    const headers = { "X-Slack-Signature": signature, "X-Slack-Request-Timestamp": timestamp };
    expect(verify(headers, body, 1531420618 + 10, secret)).toEqual({ ok: true });
  });
});

describe("verifySlackRequest: signature (T4.U.01)", () => {
  it("accepts a body signed with the secret", () => {
    expect(verify(signed())).toEqual({ ok: true });
  });

  it("accepts an empty body and multi-byte UTF-8 bodies", () => {
    for (const body of ["", "text=café", "emoji=\u{1F600}&x=éé"]) {
      expect(verify(signed(body), body)).toEqual({ ok: true });
    }
  });

  it("rejects a wrong secret", () => {
    expect(verify(signed(BODY, String(NOW), SECRET + "x"))).toEqual(bad("bad_signature"));
  });

  it("rejects a changed byte in the body and a trailing newline", () => {
    const headers = signed();
    expect(verify(headers, BODY.replace("block", "blocK"))).toEqual(bad("bad_signature"));
    expect(verify(headers, BODY + "\n")).toEqual(bad("bad_signature"));
    const utf8 = "x=é";
    expect(verify(signed(utf8), "x=è")).toEqual(bad("bad_signature"));
  });

  it("rejects the signature bound to another timestamp", () => {
    const headers = signed(BODY, String(NOW - 1));
    expect(verify({ ...headers, "x-slack-request-timestamp": String(NOW) })).toEqual(
      bad("bad_signature"),
    );
  });

  it("rejects a digest with one character changed (first, middle, last)", () => {
    const good = signed()["x-slack-signature"];
    for (const at of [3, 30, good.length - 1]) {
      const flipped = good.slice(0, at) + (good[at] === "0" ? "1" : "0") + good.slice(at + 1);
      expect(verify({ ...signed(), "x-slack-signature": flipped })).toEqual(bad("bad_signature"));
    }
  });

  it("rejects any prefix other than exactly v0=, upper-case hex and whitespace", () => {
    const good = signed()["x-slack-signature"];
    const hex = good.slice(3);
    for (const signature of [
      `v1=${hex}`,
      `V0=${hex}`,
      hex,
      `v0${hex}`,
      `v0=${hex.toUpperCase()}`,
      ` ${good}`,
      `${good} `,
      `${good},${good}`,
      "",
    ]) {
      expect(verify({ ...signed(), "x-slack-signature": signature })).toEqual(bad("bad_signature"));
    }
  });
});

describe("verifySlackRequest: headers", () => {
  it("returns missing_signature without the signature or the timestamp header", () => {
    const good = signed();
    const noSignature = { "x-slack-request-timestamp": good["x-slack-request-timestamp"] };
    const noTimestamp = { "x-slack-signature": good["x-slack-signature"] };
    createHmac.mockClear();
    expect(verify(noSignature)).toEqual(bad("missing_signature"));
    expect(verify(noTimestamp)).toEqual(bad("missing_signature"));
    expect(verify({})).toEqual(bad("missing_signature"));
    expect(verify(new Headers())).toEqual(bad("missing_signature"));
    expect(createHmac).not.toHaveBeenCalled();
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("treats undefined, non-string and empty-array values as missing", () => {
    const good = signed();
    for (const value of [undefined, 5, null, [], [5], [undefined, null]]) {
      expect(verify({ ...good, "x-slack-signature": value as never })).toEqual(
        bad("missing_signature"),
      );
      expect(verify({ ...good, "x-slack-request-timestamp": value as never })).toEqual(
        bad("missing_signature"),
      );
    }
  });

  it("reads header names in any case from a plain object and a Headers object", () => {
    const good = signed();
    const mixed = {
      "X-Slack-Signature": good["x-slack-signature"],
      "X-SLACK-REQUEST-TIMESTAMP": good["x-slack-request-timestamp"],
    };
    expect(verify(mixed)).toEqual({ ok: true });
    expect(verify(new Headers(mixed))).toEqual({ ok: true });
    expect(verify(new Headers(good))).toEqual({ ok: true });
  });

  it("ignores other headers, including look-alike names", () => {
    const good = signed();
    expect(verify({ ...good, "x-slack-signature-2": "v0=00", other: "1" })).toEqual({ ok: true });
    expect(verify({ "x-slack-signaturex": good["x-slack-signature"], ...good })).toEqual({
      ok: true,
    });
  });

  it("accepts a one-element array value", () => {
    const good = signed();
    expect(
      verify({
        "x-slack-signature": [good["x-slack-signature"]],
        "x-slack-request-timestamp": [good["x-slack-request-timestamp"]],
      }),
    ).toEqual({ ok: true });
  });

  it("fails closed on duplicate values: never picks the good one of several", () => {
    const good = signed();
    const sig = good["x-slack-signature"];
    const ts = good["x-slack-request-timestamp"];
    const wrong = signed(BODY, String(NOW), "other")["x-slack-signature"];
    // Array-valued signature, good one first and last.
    expect(verify({ ...good, "x-slack-signature": [sig, wrong] })).toEqual(bad("bad_signature"));
    expect(verify({ ...good, "x-slack-signature": [wrong, sig] })).toEqual(bad("bad_signature"));
    expect(verify({ ...good, "x-slack-signature": [sig, sig] })).toEqual(bad("bad_signature"));
    // An empty extra value must not join back into the good signature.
    expect(verify({ ...good, "x-slack-signature": [sig, ""] })).toEqual(bad("bad_signature"));
    expect(verify({ ...good, "x-slack-signature": ["", sig] })).toEqual(bad("bad_signature"));
    expect(verify({ ...good, "x-slack-signature": [sig.slice(0, 10), sig.slice(10)] })).toEqual(
      bad("bad_signature"),
    );
    expect(verify({ ...good, "x-slack-request-timestamp": [ts.slice(0, 4), ts.slice(4)] })).toEqual(
      bad("stale_timestamp"),
    );
    // The same name twice in different cases.
    expect(verify({ ...good, "X-Slack-Signature": wrong })).toEqual(bad("bad_signature"));
    expect(verify({ "X-Slack-Signature": sig, ...good })).toEqual(bad("bad_signature"));
    // Duplicate timestamps.
    expect(verify({ ...good, "x-slack-request-timestamp": [ts, ts] })).toEqual(
      bad("stale_timestamp"),
    );
    expect(verify({ ...good, "X-Slack-Request-Timestamp": ts })).toEqual(bad("stale_timestamp"));
    // A Headers object joins duplicates with ", ", which also fails.
    const headers = new Headers(good);
    headers.append("x-slack-signature", wrong);
    expect(verify(headers)).toEqual(bad("bad_signature"));
    const tsHeaders = new Headers(good);
    tsHeaders.append("x-slack-request-timestamp", ts);
    expect(verify(tsHeaders)).toEqual(bad("stale_timestamp"));
  });
});

describe("verifySlackRequest: timestamp (T4.U.02)", () => {
  it.each([0, -299, -300, 299, 300])("accepts now %+d", (offset) => {
    const timestamp = String(NOW + offset);
    expect(verify(signed(BODY, timestamp))).toEqual({ ok: true });
  });

  it.each([-301, 301, -100_000, 100_000])("returns stale_timestamp for now %+d", (offset) => {
    const timestamp = String(NOW + offset);
    expect(verify(signed(BODY, timestamp))).toEqual(bad("stale_timestamp"));
    expect(createHmac).toHaveBeenCalledTimes(1); // the signing above only
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("accepts a timestamp of 1 to 12 digits, leading zeros included, when in the window", () => {
    expect(verify(signed(BODY, "5"), BODY, 5)).toEqual({ ok: true });
    expect(verify(signed(BODY, "0"), BODY, 300)).toEqual({ ok: true });
    expect(verify(signed(BODY, "999999999999"), BODY, 999_999_999_999)).toEqual({ ok: true });
    // Leading zeros: the value is in the window and the HMAC binds the exact text.
    expect(verify(signed(BODY, `00${NOW}`))).toEqual({ ok: true });
    expect(verify(signed(BODY, "00005"), BODY, 5)).toEqual({ ok: true });
  });

  it.each([
    "1e9",
    " 1700000000",
    "1700000000 ",
    "1700000000\n",
    "-5",
    "+5",
    "0x10",
    "1.5",
    "1_700_000_000",
    "",
    "1234567890123",
    `0${NOW}00`,
    "Infinity",
    "NaN",
    "١٢٣",
    "１２３",
    `${NOW}a`,
    `a${NOW}`,
  ])("returns stale_timestamp for %j and never reaches the HMAC", (timestamp) => {
    const headers = {
      "x-slack-signature": "v0=" + "0".repeat(64),
      "x-slack-request-timestamp": timestamp,
    };
    expect(verify(headers)).toEqual(bad("stale_timestamp"));
    expect(createHmac).not.toHaveBeenCalled();
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -Infinity, 1.5, "1700000000", undefined, null])(
    "throws a TypeError naming nowSeconds for %s",
    (nowSeconds) => {
      expect(() =>
        verifySlackRequest({
          secret: SECRET,
          headers: signed(),
          body: BODY,
          nowSeconds: nowSeconds as never,
        }),
      ).toThrow(new TypeError("nowSeconds must be a safe integer"));
    },
  );

  it("throws for an unsafe integer nowSeconds", () => {
    expect(() => verify(signed(), BODY, 2 ** 53)).toThrow(TypeError);
  });
});

describe("verifySlackRequest: check order", () => {
  it("missing_signature comes before stale_timestamp", () => {
    expect(verify({ "x-slack-request-timestamp": "1" })).toEqual(bad("missing_signature"));
  });

  it("stale_timestamp comes before bad_signature", () => {
    const headers = { "x-slack-signature": "v1=nonsense", "x-slack-request-timestamp": "1" };
    expect(verify(headers)).toEqual(bad("stale_timestamp"));
  });
});

describe("verifySlackRequest: constant-time compare", () => {
  it.each([
    ["the good signature", null],
    ["a 0-length header", ""],
    ["a 1-char header", "v"],
    ["a 10 kB header", "v0=" + "a".repeat(10_000)],
    ["a same-length wrong signature", "v0=" + "0".repeat(64)],
  ])("calls timingSafeEqual once with equal-length buffers for %s", (_, value) => {
    const headers = signed();
    if (value !== null) headers["x-slack-signature"] = value;
    createHmac.mockClear();
    verify(headers);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    const [a, b] = timingSafeEqual.mock.calls[0] as [Buffer, Buffer];
    expect(Buffer.isBuffer(a) && Buffer.isBuffer(b)).toBe(true);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(createHmac).toHaveBeenCalledTimes(1);
  });

  it("decides by timingSafeEqual: a forced false fails a good signature", () => {
    timingSafeEqual.mockReturnValueOnce(false);
    expect(verify(signed())).toEqual(bad("bad_signature"));
  });

  it("decides by timingSafeEqual: a forced true passes a bad signature", () => {
    timingSafeEqual.mockReturnValueOnce(true);
    expect(verify({ ...signed(), "x-slack-signature": "v0=bad" })).toEqual({ ok: true });
  });
});

describe("verifySlackRequest: secret, body and leaks", () => {
  it.each([
    ["empty", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
  ])("throws a TypeError naming secret for a %s secret", (_, secret) => {
    const call = (headers: Headers_) => () =>
      verifySlackRequest({ secret: secret as never, headers, body: BODY, nowSeconds: NOW });
    expect(call(signed())).toThrow(new TypeError("secret must be a non-empty string"));
    expect(call({})).toThrow(new TypeError("secret must be a non-empty string"));
  });

  it("throws a TypeError naming body for a non-string body", () => {
    expect(() =>
      verifySlackRequest({
        secret: SECRET,
        headers: signed(),
        body: undefined as never,
        nowSeconds: NOW,
      }),
    ).toThrow(new TypeError("body must be a string"));
    expect(() => signSlackRequest({ secret: SECRET, timestamp: "1", body: 5 as never })).toThrow(
      new TypeError("body must be a string"),
    );
  });

  it("checks the body before the headers", () => {
    for (const headers of [{}, { "x-slack-request-timestamp": "1" }, signed()]) {
      expect(() =>
        verifySlackRequest({ secret: SECRET, headers, body: 5 as never, nowSeconds: NOW }),
      ).toThrow(new TypeError("body must be a string"));
    }
  });

  it("throws a TypeError naming headers for missing headers", () => {
    expect(() => verify(undefined as never)).toThrow(new TypeError("headers must be an object"));
    expect(() => verify(null as never)).toThrow(new TypeError("headers must be an object"));
    expect(() => verify("x-slack-signature" as never)).toThrow(TypeError);
  });

  it("puts no secret, signature or body marker in a result or an error", () => {
    const secret = "MARKERSECRET" + "q7w8e9";
    const body = "MARKERBODY" + "z1x2c3";
    const signatureMarker = "MARKERSIG" + "a4s5d6";
    const markers = [secret, body, signatureMarker];
    const outputs: string[] = [];
    const good = signed(body, String(NOW), secret);
    for (const headers of [
      good,
      { ...good, "x-slack-signature": signatureMarker },
      { ...good, "x-slack-signature": `v0=${signatureMarker}` },
      { "x-slack-signature": signatureMarker, "x-slack-request-timestamp": "1" },
      { "x-slack-signature": signatureMarker },
    ]) {
      outputs.push(JSON.stringify(verify(headers, body, NOW, secret)));
    }
    const calls = [
      () => verify({ "x-slack-signature": signatureMarker }, body, NOW, ""),
      () => verify({ "x-slack-signature": signatureMarker }, body, NaN, secret),
      () => verify(good, body as never, "x" as never, secret),
      () => signSlackRequest({ secret: "", timestamp: "1", body }),
      () => signSlackRequest({ secret, timestamp: "1", body: { body } as never }),
    ];
    for (const call of calls) {
      try {
        call();
        outputs.push("no error");
      } catch (error) {
        const e = error as Error;
        outputs.push(`${e.message}\n${e.stack ?? ""}`);
      }
    }
    for (const output of outputs) {
      for (const marker of markers) expect(output).not.toContain(marker);
    }
  });
});
