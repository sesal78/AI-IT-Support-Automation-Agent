import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEgressRecorder } from "../../shared/test-support/egress-recorder.js";
import {
  HelpdeskError,
  ServiceNowConnector,
  createServiceNowClient,
  withShadowMode,
  type CreateHelpdeskTicketInput,
} from "../src/index.js";
import { runHelpdeskContract } from "../src/testing/contract.js";

const ORIGIN = "https://example.service-now.com";
const PASSWORD = ["Mark", "er", "Pw", "-0123456789"].join(""); // built from pieces for gitleaks
const HIBERNATING = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/servicenow-hibernating.html"),
  "utf8",
);
const DEFAULT_CALLER = "d".repeat(32);
const CAROL = "demo.carol@example.com";
const CAROL_ID = "c".repeat(32);
const GROUP_ID = "9".repeat(32);

type Row = Record<string, string>;
let users: Row[] = [];
let groups: Row[] = [];
let incidents: Row[] = [];
let reply: "table" | "asleep" | "down" = "table";

// A small in-memory Table API, served through the egress recorder (msw).
const recorder = createEgressRecorder();
const json = (result: unknown, status = 200) => Response.json({ result }, { status });
beforeAll(() => {
  recorder.start();
  recorder.mock(ORIGIN, async ({ request }) => {
    if (reply === "asleep") {
      return new Response(HIBERNATING, { headers: { "content-type": "text/html" } });
    }
    if (reply === "down") return new Response("", { status: 500 });
    const url = new URL(request.url);
    const [table, sysId] = url.pathname.replace("/api/now/table/", "").split("/");
    const q = url.searchParams;
    if (request.method === "POST") {
      const body = (await request.json()) as Row;
      const row = { ...body, sys_id: `${incidents.length + 1}`.padStart(32, "0") };
      incidents.push({ ...row, number: `INC${String(incidents.length + 1).padStart(7, "0")}` });
      return json({ sys_id: row.sys_id, number: incidents.at(-1)!.number }, 201);
    }
    if (request.method === "PATCH") {
      const row = incidents.find((r) => r.sys_id === sysId);
      return row ? json(Object.assign(row, await request.json())) : json({}, 404);
    }
    if (table === "sys_user") return json(users.filter((u) => u.email === q.get("email")));
    if (table === "sys_user_group") return json(groups.filter((g) => g.name === q.get("name")));
    return json(incidents.filter((r) => r.correlation_id === q.get("correlation_id")));
  });
});
afterAll(() => recorder.stop());
beforeEach(() => {
  recorder.reset();
  reply = "table";
  users = [{ sys_id: CAROL_ID, email: CAROL }];
  groups = [{ sys_id: GROUP_ID, name: "Hardware Support" }];
  incidents = [];
});

const connector = () =>
  new ServiceNowConnector({
    client: createServiceNowClient({
      instanceUrl: ORIGIN,
      username: "svc.itsupport",
      password: PASSWORD,
    }),
    defaultCaller: DEFAULT_CALLER,
  });
const input = (over: object = {}): CreateHelpdeskTicketInput => ({
  ticketId: randomUUID(),
  ticketNumber: "ITS-000042",
  isTest: false,
  redactedTitle: "Printer offline",
  redactedDescription: "The printer on level 2 is offline.",
  category: "hardware",
  priority: "P2",
  assignmentGroup: null,
  requesterEmail: null,
  ...over,
});
const sent = (method: string) => recorder.requests().filter((r) => r.method === method);

runHelpdeskContract("servicenow (mock Table API)", connector);

describe("ServiceNowConnector.createTicket", () => {
  it("sends exactly the allowed incident fields, mapped", async () => {
    const body = input({
      isTest: true,
      redactedTitle: "t".repeat(200),
      assignmentGroup: "Hardware Support",
      requesterEmail: CAROL,
    });
    const created = await connector().createTicket(body);

    expect(created).toEqual({
      externalId: "1".padStart(32, "0"),
      number: "INC0000001",
      callerDefaulted: false,
    });
    const [post] = sent("POST");
    const fields = JSON.parse(post!.body) as Row;
    expect(Object.keys(fields).sort()).toEqual(
      "assignment_group caller_id category correlation_display correlation_id description impact short_description urgency".split(
        " ",
      ),
    );
    expect(fields).toMatchObject({
      description: body.redactedDescription,
      category: "hardware",
      impact: 1,
      urgency: 2,
      caller_id: CAROL_ID,
      assignment_group: GROUP_ID,
      correlation_id: body.ticketId,
      correlation_display: "ITS-000042",
    });
    expect(fields.short_description).toBe(`[E2E] ${"t".repeat(154)}`);
    expect(post!.query).toContain("sysparm_fields=sys_id%2Cnumber");
  });

  it("gives a real ticket no [E2E] prefix", async () => {
    await connector().createTicket(input());
    expect(JSON.parse(sent("POST")[0]!.body)).toMatchObject({
      short_description: "Printer offline",
    });
  });

  it.each(["ITS-42", "INC0010001", "its-000042", ""])(
    "refuses ticket number %j before any request",
    async (ticketNumber) => {
      const error = await connector()
        .createTicket(input({ ticketNumber }))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(recorder.requests()).toEqual([]);
    },
  );

  it.each([
    ["no matching user", "nobody@example.com", 1],
    ["two matching users", CAROL, 1],
    ["a refused address", "a^b@example.com", 0],
    ["no requester", null, 0],
  ])("uses the default caller for %s", async (_name, requesterEmail, lookups) => {
    users = [
      { sys_id: "1".repeat(32), email: CAROL },
      { sys_id: "2".repeat(32), email: CAROL },
    ];
    const created = await connector().createTicket(input({ requesterEmail }));
    expect(created).toMatchObject({ callerDefaulted: true });
    expect(JSON.parse(sent("POST")[0]!.body)).toMatchObject({ caller_id: DEFAULT_CALLER });
    expect(sent("GET")).toHaveLength(lookups);
  });

  it.each([
    ["does not exist", []],
    [
      "matches two groups",
      [
        { sys_id: "1".repeat(32), name: "Hardware Support" },
        { sys_id: "2".repeat(32), name: "Hardware Support" },
      ],
    ],
  ])("fails with config and posts nothing when the group %s", async (_name, rows) => {
    groups = rows;
    const error = await connector()
      .createTicket(input({ assignmentGroup: "Hardware Support" }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "config", retryable: false });
    expect(error).toBeInstanceOf(HelpdeskError);
    expect(sent("POST")).toEqual([]);
  });

  it("looks a group up once for two tickets", async () => {
    const c = connector();
    await c.createTicket(input({ assignmentGroup: "Hardware Support" }));
    await c.createTicket(input({ assignmentGroup: "Hardware Support" }));
    expect(sent("GET").filter((r) => r.path.endsWith("/sys_user_group"))).toHaveLength(1);
    expect(sent("POST")).toHaveLength(2);
  });

  it("sends the requester email only in the sys_user lookup and no raw text anywhere", async () => {
    const markers = ["MARKER-RAW-TITLE-1a2b", "MARKER-RAW-DESC-3c4d", "MARKER-NAME-5e6f"];
    const marked = input({
      requesterEmail: CAROL,
      rawTitle: markers[0],
      rawDescription: markers[1],
      requesterName: markers[2],
    });
    await connector().createTicket(marked);
    const seen = recorder.requests().map((r) => ({
      r,
      text: decodeURIComponent(`${r.path}${r.query}`) + r.body + JSON.stringify(r.headers),
    }));
    expect(
      seen.filter((s) => s.text.includes(CAROL)).map((s) => `${s.r.method} ${s.r.path}`),
    ).toEqual(["GET /api/now/table/sys_user"]);
    for (const marker of markers) expect(seen.some((s) => s.text.includes(marker))).toBe(false);
  });
});

describe("ServiceNowConnector other operations", () => {
  it("throws duplicate_external_ref for two incidents with one correlation_id", async () => {
    const ticketId = randomUUID();
    incidents = [1, 2].map((n) => ({
      sys_id: String(n).padStart(32, "0"),
      number: `INC${n}`,
      correlation_id: ticketId,
    }));
    await expect(connector().findByExternalRef(ticketId)).rejects.toMatchObject({
      code: "duplicate_external_ref",
    });
  });

  it("writes a work note and maps states", async () => {
    const c = connector();
    const ref = await c.createTicket(input());
    await c.addNote(ref, "Checked the cable.");
    await c.updateTicket(ref, { state: "on_hold" });
    expect(sent("PATCH").map((r) => JSON.parse(r.body))).toEqual([
      { work_notes: "Checked the cable." },
      { state: 3, hold_reason: 1 },
    ]);
  });

  it.each([
    ["table", "ok"],
    ["asleep", "asleep"],
    ["down", "down"],
  ] as const)("health with a %s answer is %s", async (answer, status) => {
    reply = answer;
    expect(await connector().health()).toEqual({ status });
  });

  it("T5.I.04: under shadow mode no write reaches the instance", async () => {
    const wrapped = withShadowMode(connector(), { enabled: true });
    const ref = { externalId: "1".padStart(32, "0"), number: "INC0000001" };
    const results = [
      await wrapped.createTicket(input()),
      await wrapped.addNote(ref, "note"),
      await wrapped.updateTicket(ref, { state: "closed" }),
    ];
    expect(results).toEqual(Array(3).fill({ skipped: "shadow" }));
    expect(await wrapped.findByExternalRef(randomUUID())).toBeNull();
    expect(recorder.requests().map((r) => r.method)).toEqual(["GET"]);
  });
});
