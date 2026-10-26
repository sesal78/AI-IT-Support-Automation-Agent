import { describe, expect, it } from "vitest";
import {
  checkReviewBinding,
  checkReviewer,
  type Interaction,
  InteractionPayloadError,
  type InteractionPayloadReason,
  parseInteraction,
} from "./interaction";

// Fake IDs only (the repo is public). U0A5ATR4WJD is the reviewer ID the
// phase 4 spec names for the allow-list example.
const REVIEW_ID = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const USER_ID = "U0FAKEUSER1";
const CHANNEL_ID = "C0FAKECHAN1";
const MESSAGE_TS = "1792977929.000100";
const RESPONSE_URL = "https://hooks.slack.com/actions/T0000000000/0/test";
const FORM = "application/x-www-form-urlencoded";
const MARKER = "MARKER-7c1d-leak-check";

type Json = Record<string, unknown>;

function payload(overrides: Json = {}): Json {
  return {
    type: "block_actions",
    user: { id: USER_ID, username: "reviewer", team_id: "T0000000000" },
    channel: { id: CHANNEL_ID, name: "itsupport-review" },
    container: { type: "message", message_ts: MESSAGE_TS, channel_id: CHANNEL_ID },
    response_url: RESPONSE_URL,
    actions: [
      {
        type: "button",
        action_id: "review_approve",
        block_id: "review",
        value: REVIEW_ID,
        action_ts: "1792977930.000200",
      },
    ],
    ...overrides,
  };
}

function action(overrides: Json): Json[] {
  return [{ type: "button", action_id: "review_approve", value: REVIEW_ID, ...overrides }];
}

/** Form-encodes like Slack: spaces as `+` (URLSearchParams). */
const form = (value: unknown) => new URLSearchParams({ payload: JSON.stringify(value) }).toString();

function reasonOf(run: () => unknown): InteractionPayloadReason {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InteractionPayloadError);
    return (error as InteractionPayloadError).reason;
  }
  throw new Error("expected parseInteraction to throw");
}

const reason = (rawBody: string, contentType: string | null = FORM) =>
  reasonOf(() => parseInteraction(rawBody, contentType));

const expected: Interaction = {
  decision: "approve",
  reviewId: REVIEW_ID,
  userId: USER_ID,
  channelId: CHANNEL_ID,
  messageTs: MESSAGE_TS,
  responseUrl: RESPONSE_URL,
};

describe("parseInteraction: valid payloads (T4.U.04)", () => {
  it("parses a form-encoded approve payload", () => {
    expect(parseInteraction(form(payload()), FORM)).toEqual(expected);
  });

  it("parses a reject payload to reject", () => {
    const body = form(payload({ actions: action({ action_id: "review_reject" }) }));
    expect(parseInteraction(body, FORM)).toEqual({ ...expected, decision: "reject" });
  });

  it("decodes `+` and `%20` the same way", () => {
    const json = JSON.stringify(payload({ message: { text: "Review needed: a b" } }), null, 2);
    const plus = new URLSearchParams({ payload: json }).toString();
    const percent = `payload=${encodeURIComponent(json)}`;
    expect(plus).toContain("+");
    expect(percent).toContain("%20");
    expect(parseInteraction(plus, FORM)).toEqual(expected);
    expect(parseInteraction(percent, FORM)).toEqual(expected);
  });

  it("accepts Slack's extra fields and drops them from the result", () => {
    const body = form(
      payload({
        team: { id: "T0000000000", domain: "example" },
        message: { ts: MESSAGE_TS, text: "card", blocks: [] },
        trigger_id: "1.2.3",
        state: { values: { a: { b: { type: "plain_text_input", value: "x" } } } },
        api_app_id: "A0000000000",
        enterprise: null,
        is_enterprise_install: false,
      }),
    );
    const result = parseInteraction(body, FORM);
    expect(result).toEqual(expected);
    expect(Object.keys(result).sort()).toEqual(
      ["channelId", "decision", "messageTs", "responseUrl", "reviewId", "userId"].sort(),
    );
  });

  it("ignores other form fields next to payload", () => {
    expect(parseInteraction(`${form(payload())}&other=1`, FORM)).toEqual(expected);
  });
});

describe("parseInteraction: content type", () => {
  it.each([
    FORM,
    "application/x-www-form-urlencoded; charset=utf-8",
    "application/x-www-form-urlencoded;charset=UTF-8",
    "Application/X-WWW-Form-URLEncoded",
    "APPLICATION/X-WWW-FORM-URLENCODED ; charset=utf-8",
  ])("accepts %j", (contentType) => {
    expect(parseInteraction(form(payload()), contentType)).toEqual(expected);
  });

  // A leading space is refused: Headers.get() already trims the value, so only
  // a caller that bypasses Headers could pass one.
  it.each([
    ["application/json"],
    ["application/json; charset=utf-8"],
    ["multipart/form-data; boundary=x"],
    ["text/plain"],
    [""],
    [" application/x-www-form-urlencoded"],
    ["application/x-www-form-urlencodedX"],
    ["application/x-www-form-urlencoded-x"],
    ["xapplication/x-www-form-urlencoded"],
    ["application/x-www-form-urlencoded charset=utf-8"],
  ])("refuses %j with content_type", (contentType) => {
    expect(reason(form(payload()), contentType)).toBe("content_type");
  });

  it("refuses a missing header with content_type", () => {
    expect(reason(form(payload()), null)).toBe("content_type");
  });

  it("refuses a JSON body sent as JSON with content_type", () => {
    expect(reason(JSON.stringify(payload()), "application/json")).toBe("content_type");
  });
});

describe("parseInteraction: form field", () => {
  it.each([
    ["an empty body", ""],
    ["a body without payload", "foo=bar&baz=1"],
    ["a JSON body", JSON.stringify(payload())],
    ["a field named Payload", `Payload=${encodeURIComponent(JSON.stringify(payload()))}`],
  ])("refuses %s with no_payload", (_name, body) => {
    expect(reason(body)).toBe("no_payload");
  });

  // Never pick one of two payloads: the second could be the one a reviewer did not send.
  it("refuses a duplicate payload field with no_payload", () => {
    const one = form(payload());
    const other = form(payload({ actions: action({ action_id: "review_reject" }) }));
    expect(reason(`${one}&${other}`)).toBe("no_payload");
    expect(reason(`${one}&${one}`)).toBe("no_payload");
    expect(reason(`${one}&payload=`)).toBe("no_payload");
  });

  it("refuses a large body without payload quickly (the route caps the body at 128 KB)", () => {
    const started = Date.now();
    expect(reason(`x=${"a".repeat(2_000_000)}`)).toBe("no_payload");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("parseInteraction: JSON", () => {
  it.each([
    ["an empty payload", "payload="],
    ["plain text", "payload=hello"],
    ["truncated JSON", `payload=${encodeURIComponent('{"type":"block_actions"')}`],
    ["single quotes", `payload=${encodeURIComponent("{'type':'block_actions'}")}`],
  ])("refuses %s with not_json", (_name, body) => {
    expect(reason(body)).toBe("not_json");
  });

  it.each([
    ["null", null],
    ["a number", 42],
    ["a string", "block_actions"],
    ["true", true],
    ["an array", [payload()]],
    ["an empty object", {}],
  ])("refuses %s at the top level with wrong_type", (_name, value) => {
    expect(reason(form(value))).toBe("wrong_type");
  });

  it("does not pollute Object.prototype through __proto__ or constructor keys", () => {
    const json = JSON.stringify(payload()).replace(
      /^\{/,
      '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},',
    );
    const result = parseInteraction(`payload=${encodeURIComponent(json)}`, FORM);
    expect(result).toEqual(expected);
    expect(({} as Json).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("refuses __proto__ as the only source of a field", () => {
    const json = JSON.stringify(payload({ user: undefined })).replace(
      /^\{/,
      `{"__proto__":{"user":{"id":"${USER_ID}"}},`,
    );
    expect(reason(`payload=${encodeURIComponent(json)}`)).toBe("missing_field");
  });

  it("survives deep nesting in an ignored field and at the top level", () => {
    const depth = 50_000;
    const deep = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const nested = JSON.stringify(payload()).replace(/^\{/, `{"state":${deep},`);
    const body = `payload=${encodeURIComponent(nested)}`;
    let result: unknown;
    try {
      result = parseInteraction(body, FORM);
    } catch (error) {
      expect(error).toBeInstanceOf(InteractionPayloadError);
      expect((error as InteractionPayloadError).reason).toBe("not_json");
    }
    if (result !== undefined) expect(result).toEqual(expected);
    expect(["wrong_type", "not_json"]).toContain(reason(`payload=${encodeURIComponent(deep)}`));
  });
});

describe("parseInteraction: type (T4.U.04)", () => {
  it.each([
    ["view_submission", { type: "view_submission" }],
    ["block_suggestion", { type: "block_suggestion" }],
    ["Block_Actions", { type: "Block_Actions" }],
    ["block_actions with a space", { type: "block_actions " }],
    ["a missing type", { type: undefined }],
    ["a number", { type: 1 }],
    ["an array", { type: ["block_actions"] }],
  ])("refuses %s with wrong_type", (_name, overrides) => {
    expect(reason(form(payload(overrides)))).toBe("wrong_type");
  });
});

describe("parseInteraction: actions (T4.U.04)", () => {
  it.each([
    ["an unknown action_id", { actions: action({ action_id: "review_escalate" }) }],
    ["review_approve with a space", { actions: action({ action_id: "review_approve " }) }],
    ["Review_Approve", { actions: action({ action_id: "Review_Approve" }) }],
    ["review_approved", { actions: action({ action_id: "review_approved" }) }],
    ["a missing action_id", { actions: action({ action_id: undefined }) }],
    ["an action_id that is a number", { actions: action({ action_id: 1 }) }],
    ["two actions", { actions: [...action({}), ...action({ action_id: "review_reject" })] }],
    ["two equal actions", { actions: [...action({}), ...action({})] }],
    ["zero actions", { actions: [] }],
    ["missing actions", { actions: undefined }],
    ["actions as an object", { actions: action({})[0] }],
    ["an action that is null", { actions: [null] }],
    ["an action that is a string", { actions: ["review_approve"] }],
  ])("refuses %s with unknown_action", (_name, overrides) => {
    expect(reason(form(payload(overrides)))).toBe("unknown_action");
  });

  // Lower-case RFC 9562 UUIDs with a version digit 1-8 and variant 8-b only
  // (Postgres writes them in this form). The nil and max UUIDs are refused.
  it.each([
    ["a missing value", undefined],
    ["an empty value", ""],
    ["a value that is not a UUID", "not-a-uuid"],
    ["a number", 42],
    ["an array", [REVIEW_ID]],
    ["upper case", REVIEW_ID.toUpperCase()],
    ["braces", `{${REVIEW_ID}}`],
    ["a missing hyphen", REVIEW_ID.replace("-", "")],
    ["a hyphen moved", "3f2b8c1e5-a4d-4e6f-9b7a-1c2d3e4f5a6b"],
    ["the nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["the max UUID", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ["version 0", "3f2b8c1e-5a4d-0e6f-9b7a-1c2d3e4f5a6b"],
    ["version 9", "3f2b8c1e-5a4d-9e6f-9b7a-1c2d3e4f5a6b"],
    ["variant c", "3f2b8c1e-5a4d-4e6f-cb7a-1c2d3e4f5a6b"],
    ["variant 7", "3f2b8c1e-5a4d-4e6f-7b7a-1c2d3e4f5a6b"],
    ["a non-hex digit", "3f2b8c1g-5a4d-4e6f-9b7a-1c2d3e4f5a6b"],
    ["a leading character", `x${REVIEW_ID}`],
    ["a trailing character", `${REVIEW_ID}x`],
    ["a trailing newline", `${REVIEW_ID}\n`],
    ["a leading space", ` ${REVIEW_ID}`],
    ["a short first group", "3f2b8c1-5a4d-4e6f-9b7a-1c2d3e4f5a6b"],
    ["a short last group", "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6"],
    ["a long last group", "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6bc"],
    ["a short second group", "3f2b8c1e-5a4-4e6f-9b7a-1c2d3e4f5a6b"],
    ["a short third group", "3f2b8c1e-5a4d-4e6-9b7a-1c2d3e4f5a6b"],
    ["a short fourth group", "3f2b8c1e-5a4d-4e6f-9b7-1c2d3e4f5a6b"],
    ["two UUIDs", `${REVIEW_ID},${REVIEW_ID}`],
  ])("refuses %s with bad_review_id", (_name, value) => {
    expect(reason(form(payload({ actions: action({ value }) })))).toBe("bad_review_id");
  });

  it.each([
    ["version 1", "3f2b8c1e-5a4d-1e6f-8b7a-1c2d3e4f5a6b"],
    ["version 7, variant b", "019a2b3c-4d5e-7f60-b123-456789abcdef"],
    ["variant a", "3f2b8c1e-5a4d-8e6f-ab7a-1c2d3e4f5a6b"],
    ["all digits", "12345678-1234-4123-9123-123456789012"],
  ])("accepts %s", (_name, value) => {
    const body = form(payload({ actions: action({ value }) }));
    expect(parseInteraction(body, FORM).reviewId).toBe(value);
  });
});

describe("parseInteraction: fields", () => {
  const bad = [
    ["missing", undefined],
    ["a number", 123],
    ["an empty string", ""],
    ["an array", [USER_ID]],
    ["an object", { id: USER_ID }],
    ["null", null],
    ["true", true],
  ] as const;

  it.each(bad)("refuses a user.id that is %s with missing_field", (_name, id) => {
    expect(reason(form(payload({ user: { id } })))).toBe("missing_field");
  });

  it.each(bad)("refuses a channel.id that is %s with missing_field", (_name, id) => {
    expect(reason(form(payload({ channel: { id } })))).toBe("missing_field");
  });

  it.each(bad)("refuses a container.message_ts that is %s with missing_field", (_name, ts) => {
    expect(reason(form(payload({ container: { type: "message", message_ts: ts } })))).toBe(
      "missing_field",
    );
  });

  it.each([
    ["user", { user: undefined }],
    ["user as a string", { user: USER_ID }],
    ["channel", { channel: undefined }],
    ["channel as null", { channel: null }],
    ["container", { container: undefined }],
    ["container as an array", { container: [MESSAGE_TS] }],
    ["response_url", { response_url: undefined }],
    ["response_url as a number", { response_url: 1 }],
    ["response_url as an array", { response_url: [RESPONSE_URL] }],
  ])("refuses a missing or wrong %s with missing_field", (_name, overrides) => {
    expect(reason(form(payload(overrides)))).toBe("missing_field");
  });

  // Channel ID, not the container's channel_id: Slack sends both, the spec reads channel.id.
  it("reads channel.id and container.message_ts, not other copies", () => {
    const body = form(
      payload({
        container: { type: "message", message_ts: MESSAGE_TS, channel_id: "C0OTHERCHAN" },
        message: { ts: "1.1" },
      }),
    );
    expect(parseInteraction(body, FORM)).toEqual(expected);
  });

  it("keeps the values exactly as sent, without trimming", () => {
    const body = form(payload({ user: { id: ` ${USER_ID}` } }));
    expect(parseInteraction(body, FORM).userId).toBe(` ${USER_ID}`);
  });
});

describe("parseInteraction: response_url", () => {
  it.each([
    "https://evil.example/x",
    "http://hooks.slack.com/x",
    "HTTPS://hooks.slack.com/actions/T0/1/x",
    "https://HOOKS.SLACK.COM/actions/T0/1/x",
    "https://hooks.slack.com",
    "https://hooks.slack.com.evil.example/",
    "https://hooks.slack.com.evil.example/actions",
    "https://hooks.slack.com@evil.example/",
    "https://user@hooks.slack.com/actions",
    "https://hooks.slack.com:443/actions",
    "https://hooks.slack.com:8443/actions",
    "https://hooks.slack.com%2eevil.example/",
    "https://hooks%2Eslack.com/actions",
    "https://hooks.slack.com%2F@evil.example/",
    "javascript:alert(1)//https://hooks.slack.com/",
    " https://hooks.slack.com/actions/T0/1/x",
    "\thttps://hooks.slack.com/actions/T0/1/x",
    "https://hooks.slack.com/actions/T0/1/x ",
    "https://hooks.slack.com/actions/\tT0/1/x",
    "https://hooks.slack.com/actions/T0\n/1/x",
    "https://hooks.slack.com/a b",
    "https://hooks.slack.com/actions/../../x",
    "https://hooks.slack.com\\@evil.example/",
    "//hooks.slack.com/actions",
    "hooks.slack.com/actions",
    "",
  ])("refuses %j with bad_response_url", (url) => {
    expect(reason(form(payload({ response_url: url })))).toBe("bad_response_url");
  });

  it.each([
    "https://hooks.slack.com/",
    "https://hooks.slack.com/actions/T0000000000/1234567890/AbCdEf0123",
    "https://hooks.slack.com/app/T0/1/x?y=1",
  ])("accepts %j unchanged", (url) => {
    const body = form(payload({ response_url: url }));
    expect(parseInteraction(body, FORM).responseUrl).toBe(url);
  });
});

describe("parseInteraction: reason order", () => {
  it("checks type, then actions, then the review ID, then fields, then the URL", () => {
    const allBad = {
      type: "view_submission",
      actions: [],
      user: undefined,
      response_url: "https://evil.example/",
    };
    expect(reason(form(payload(allBad)))).toBe("wrong_type");
    expect(reason(form(payload({ ...allBad, type: "block_actions" })))).toBe("unknown_action");
    const oneBadValue = { ...allBad, type: "block_actions", actions: action({ value: "x" }) };
    expect(reason(form(payload(oneBadValue)))).toBe("bad_review_id");
    const fieldsBad = { ...oneBadValue, actions: action({}) };
    expect(reason(form(payload(fieldsBad)))).toBe("missing_field");
    expect(reason(form(payload({ ...fieldsBad, user: { id: USER_ID } })))).toBe("bad_response_url");
  });

  it("checks the content type before the body", () => {
    expect(reason("", "application/json")).toBe("content_type");
  });
});

describe("InteractionPayloadError: no leaks", () => {
  const cases: Array<[string, string]> = [
    ["content type", "application/json"],
    ["no payload", FORM],
    ["not json", FORM],
    ["wrong type", FORM],
    ["unknown action", FORM],
    ["bad review id", FORM],
    ["missing field", FORM],
    ["bad response url", FORM],
  ];
  const bodies: Record<string, string> = {
    "content type": form(payload({ user: { id: MARKER } })),
    "no payload": `${MARKER}=${MARKER}`,
    "not json": `payload=${MARKER}`,
    "wrong type": form(payload({ type: MARKER })),
    "unknown action": form(payload({ actions: action({ action_id: MARKER }) })),
    "bad review id": form(payload({ actions: action({ value: MARKER }) })),
    "missing field": form(payload({ user: { id: [MARKER] }, extra: MARKER })),
    "bad response url": form(payload({ response_url: `https://${MARKER}.example/` })),
  };

  it.each(cases)("a %s error holds no input value", (name, contentType) => {
    let caught: unknown;
    try {
      parseInteraction(bodies[name], `${contentType}${name === "content type" ? MARKER : ""}`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InteractionPayloadError);
    const error = caught as InteractionPayloadError;
    expect(error.name).toBe("InteractionPayloadError");
    expect(error.message).toBe(`invalid Slack interaction payload: ${error.reason}`);
    expect(error.cause).toBeUndefined();
    for (const text of [
      error.message,
      error.reason,
      String(error),
      error.stack ?? "",
      JSON.stringify(error),
      JSON.stringify(Object.getOwnPropertyNames(error).map((key) => Reflect.get(error, key))),
    ]) {
      expect(text).not.toContain(MARKER);
    }
    expect(Object.keys(error)).toEqual(["reason"]);
  });

  it("is an Error with the reason as its only own enumerable field", () => {
    const error = new InteractionPayloadError("not_json");
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe("not_json");
    expect({ ...error }).toEqual({ reason: "not_json" });
  });
});

describe("checkReviewer", () => {
  const listed = "U0A5ATR4WJD";
  const interaction = (userId: string): Interaction => ({ ...expected, userId });
  const refused = { allowed: false, status: 403, kind: "not_allow_listed" };

  it("allows an allow-listed ID", () => {
    expect(checkReviewer(interaction(listed), [listed])).toEqual({ allowed: true });
    expect(checkReviewer(interaction(listed), ["U0OTHER0001", listed])).toEqual({
      allowed: true,
    });
  });

  it.each([
    ["a prefix", "U0A5ATR4WJ"],
    ["a suffix", "U0A5ATR4WJDX"],
    ["lower case", "u0a5atr4wjd"],
    ["a leading space", ` ${listed}`],
    ["a trailing space", `${listed} `],
    ["another ID", "U0000000099"],
    ["an empty ID", ""],
  ])("refuses %s with 403 not_allow_listed", (_name, userId) => {
    expect(checkReviewer(interaction(userId), [listed])).toEqual(refused);
  });

  it("refuses everyone when the list is empty", () => {
    expect(checkReviewer(interaction(listed), [])).toEqual(refused);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["the ID as a string", listed],
    ["a comma-separated string", `${listed},U0OTHER0001`],
    ["an object", { [listed]: true }],
    ["a Set", new Set([listed])],
  ])("fails closed when the list is %s", (_name, list) => {
    expect(checkReviewer(interaction(listed), list as unknown as string[])).toEqual(refused);
  });
});

describe("checkReviewBinding", () => {
  const ENV_CHANNEL = CHANNEL_ID;
  const review = { ticketId: "7a9c0d1e-2f3a-4b5c-8d6e-7f8091a2b3c4", slackTs: MESSAGE_TS };
  const base = {
    interaction: expected,
    channelId: ENV_CHANNEL,
    e2eMode: false,
    review,
    ticket: { isTest: false },
  };
  const unknown = { allowed: false, status: 404, kind: "unknown_review" };
  const mismatch = { allowed: false, status: 403, kind: "binding_mismatch" };
  const envMismatch = { allowed: false, status: 403, kind: "env_mismatch" };

  it("allows a bound review on the matching environment", () => {
    expect(checkReviewBinding(base)).toEqual({ allowed: true });
    expect(checkReviewBinding({ ...base, e2eMode: true, ticket: { isTest: true } })).toEqual({
      allowed: true,
    });
  });

  it("returns 404 unknown_review for a null review", () => {
    expect(checkReviewBinding({ ...base, review: null })).toEqual(unknown);
  });

  it("returns 403 binding_mismatch for another channel", () => {
    expect(checkReviewBinding({ ...base, channelId: "C0OTHERCHAN" })).toEqual(mismatch);
    const other = { ...expected, channelId: "C0OTHERCHAN" };
    expect(checkReviewBinding({ ...base, interaction: other })).toEqual(mismatch);
  });

  it("returns 403 binding_mismatch for another message ts", () => {
    expect(checkReviewBinding({ ...base, review: { ...review, slackTs: "1.000001" } })).toEqual(
      mismatch,
    );
    const other = { ...expected, messageTs: `${MESSAGE_TS}1` };
    expect(checkReviewBinding({ ...base, interaction: other })).toEqual(mismatch);
  });

  it("returns 403 binding_mismatch for a review with slackTs null", () => {
    expect(checkReviewBinding({ ...base, review: { ...review, slackTs: null } })).toEqual(mismatch);
  });

  it("returns 403 env_mismatch for a test ticket with e2eMode false", () => {
    expect(checkReviewBinding({ ...base, ticket: { isTest: true } })).toEqual(envMismatch);
  });

  it("returns 403 env_mismatch for a non-test ticket with e2eMode true", () => {
    expect(checkReviewBinding({ ...base, e2eMode: true })).toEqual(envMismatch);
  });

  // The ticket row should always exist for a review; a missing one cannot prove
  // its environment, so it fails closed after the binding check.
  it("returns 403 env_mismatch for a null ticket on either environment", () => {
    expect(checkReviewBinding({ ...base, ticket: null })).toEqual(envMismatch);
    expect(checkReviewBinding({ ...base, ticket: null, e2eMode: true })).toEqual(envMismatch);
  });

  it("fails closed on a non-boolean isTest or e2eMode", () => {
    const loose = (value: unknown) => value as boolean;
    expect(checkReviewBinding({ ...base, ticket: { isTest: loose(undefined) } })).toEqual(
      envMismatch,
    );
    expect(checkReviewBinding({ ...base, ticket: { isTest: loose(0) } })).toEqual(envMismatch);
    expect(checkReviewBinding({ ...base, e2eMode: loose(undefined) })).toEqual(envMismatch);
  });

  it("checks in order: 404 before binding, binding before environment", () => {
    const allBad = {
      ...base,
      channelId: "C0OTHERCHAN",
      e2eMode: true,
      review: null,
      ticket: { isTest: false },
    };
    expect(checkReviewBinding(allBad)).toEqual(unknown);
    expect(checkReviewBinding({ ...allBad, review: { ...review, slackTs: null } })).toEqual(
      mismatch,
    );
    expect(checkReviewBinding({ ...allBad, review, channelId: ENV_CHANNEL })).toEqual(envMismatch);
  });

  it("allows exactly the combinations where every check holds", () => {
    const flags = [false, true];
    let allowed = 0;
    for (const found of flags)
      for (const channelMatch of flags)
        for (const tsMatch of flags)
          for (const isTest of flags)
            for (const e2eMode of flags) {
              const result = checkReviewBinding({
                interaction: expected,
                channelId: channelMatch ? CHANNEL_ID : "C0OTHERCHAN",
                e2eMode,
                review: found ? { ...review, slackTs: tsMatch ? MESSAGE_TS : "1.000001" } : null,
                ticket: { isTest },
              });
              const ok = found && channelMatch && tsMatch && isTest === e2eMode;
              const kind = !found
                ? "unknown_review"
                : !channelMatch || !tsMatch
                  ? "binding_mismatch"
                  : "env_mismatch";
              expect(result).toEqual(
                ok ? { allowed: true } : { allowed: false, status: found ? 403 : 404, kind },
              );
              if (ok) allowed += 1;
            }
    // 32 combinations; allowed only with every match and isTest === e2eMode.
    expect(allowed).toBe(2);
  });
});
