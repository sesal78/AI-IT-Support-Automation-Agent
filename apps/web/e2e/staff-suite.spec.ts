import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import axe from "axe-core";
import { clientFor } from "../../../packages/db/integration/pg-container.js";
import { mintJwt } from "../../../packages/db/integration/rest-stack.js";
import {
  createTestStaffUser,
  type TestStaffUser,
} from "../../../packages/db/integration/test-users.js";
import { mockSensitiveAnswer } from "../../../services/pipeline/test-support/provider-mocks.js";
import { startPipelineStack, type PipelineStack } from "./support/pipeline-stack";

const base = "http://127.0.0.1:3005";
const ticket = randomUUID();
const ticketPath = `/staff/tickets/${ticket}`;
const title = "Staff suite printer fixture";
let stack: PipelineStack;
let admin: TestStaffUser;

test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 375, height: 812 } });

async function withDb<T>(work: (db: ReturnType<typeof clientFor>) => Promise<T>): Promise<T> {
  const db = clientFor(stack.restStack.pg);
  await db.connect();
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  stack = await startPipelineStack(base, "builtin");
  mockSensitiveAnswer(stack.runner.egress);
  admin = await createTestStaffUser(stack.restStack, { role: "admin" });
  await withDb(async (db) => {
    await db.query(
      `insert into itsupport.tickets
         (id, source, status, helpdesk, raw_title, raw_description, requester_email, idempotency_key)
       values ($1, 'web', 'incident_created', 'builtin', 'Private title', 'Private body',
               'staff-suite@example.test', 'staff-suite-printer')`,
      [ticket],
    );
    await db.query(
      "insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description) values ($1, $2, $3)",
      [ticket, title, "The printer shows an error."],
    );
    await db.query(
      "insert into itsupport.helpdesk_tickets (ticket_id, priority, category, state) values ($1, 'P2', 'network', 'new')",
      [ticket],
    );
  });
});
test.afterAll(async () => {
  await stack?.stop();
});
test.afterEach(async () => {
  if (stack) {
    expect(await stack.webEgressProblems()).toEqual([]);
    stack.runner.egress.assertClean();
  }
});

async function fixtureCookie(user: TestStaffUser): Promise<string> {
  const { url, jwtSecret } = stack.restStack;
  const jar = new Map<string, string>();
  const client = createServerClient(url, mintJwt(jwtSecret, { role: "anon" }), {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) jar.set(name, value);
      },
    },
  });
  const { error } = await client.auth.signInWithPassword({
    email: user.email,
    password: user.password,
  });
  expect(error === null && jar.size > 0).toBe(true);
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

test("T5.E.01: crawls the staff routes with refused sessions", async ({ request }) => {
  const original = JSON.parse(
    readFileSync(new URL("../.next/server/app-paths-manifest.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  expect(
    Object.keys(original)
      .filter((path) => path.startsWith("/staff/"))
      .sort(),
  ).toEqual([
    "/staff/login/page",
    "/staff/login/submit/route",
    "/staff/logout/route",
    "/staff/session-ended/route",
    "/staff/tickets/[id]/actions/route",
    "/staff/tickets/[id]/decide/route",
    "/staff/tickets/[id]/page",
    "/staff/tickets/page",
  ]);

  const bearer = await createTestStaffUser(stack.restStack, { role: "agent" });
  const agent = await fixtureCookie(bearer);
  const unconfirmed = await createTestStaffUser(stack.restStack, { role: "agent" });
  const unconfirmedCookie = await fixtureCookie(unconfirmed);
  await withDb((db) =>
    db.query("update auth.users set email_confirmed_at = null where id = $1", [unconfirmed.userId]),
  );
  const denied = [
    "",
    await fixtureCookie(await createTestStaffUser(stack.restStack)),
    await fixtureCookie(
      await createTestStaffUser(stack.restStack, { role: "agent", active: false }),
    ),
    unconfirmedCookie,
  ];
  for (const cookie of denied) {
    const headers = { cookie };
    for (const path of ["/staff/tickets", ticketPath]) {
      const result = await request.get(base + path, { headers, maxRedirects: 0 });
      expect(result.status(), path).toBe(307);
      const location = new URL(result.headers()["location"]!, base);
      expect(location.pathname, path).toBe(cookie ? "/staff/session-ended" : "/staff/login");
    }
    for (const suffix of ["actions", "decide"]) {
      const result = await request.post(`${base}${ticketPath}/${suffix}`, {
        headers,
        data: suffix === "decide" ? { decision: "approve" } : { kind: "note", body: "Denied" },
      });
      expect(result.status(), suffix).toBe(cookie ? 403 : 401);
    }
  }
  expect((await request.get(base + "/staff/login")).status()).toBe(200);
  expect((await request.post(base + "/staff/login/submit", { data: {} })).status()).toBe(400);
  expect((await request.get(base + "/staff/logout")).status()).toBe(405);
  expect((await request.get(base + "/staff/session-ended")).status()).toBe(403);
  const decision = await request.post(`${base}${ticketPath}/decide`, {
    headers: { cookie: agent },
    data: { decision: "approve" },
  });
  expect(decision.status()).toBe(403);
  expect(await eventTypes(ticket)).toEqual([]);
});

async function focus(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let tab = 0; tab < 40; tab++) {
    if (await target.evaluate((node) => document.activeElement === node)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

async function keyboardLogin(page: Page, user: TestStaffUser) {
  await page.goto(base + "/staff/login");
  await focus(page, page.getByLabel("Email"));
  await page.keyboard.insertText(user.email);
  await focus(page, page.getByLabel("Password"));
  await page.keyboard.insertText(user.password);
  await focus(page, page.getByRole("button", { name: "Sign in" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(base + "/staff/tickets");
}

async function audit(page: Page) {
  await page.addScriptTag({ content: axe.source });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveCSS("color-scheme", colorScheme);
    await page.evaluate(async () => {
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
      const transitions = document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition);
      await Promise.allSettled(transitions.map((animation) => animation.finished));
    });
    const results = await page.evaluate(async () => {
      const axe = (window as Window & { axe?: typeof import("axe-core") }).axe!;
      const { violations } = await axe.run();
      return violations
        .filter(({ impact }) => impact === "serious" || impact === "critical")
        .map(({ id, impact, nodes }) => ({
          id,
          impact,
          targets: nodes.map(({ target, any }) => ({
            target,
            details: any.map(({ data }) => data),
          })),
        }));
    });
    expect(results, `axe ${colorScheme} on ${new URL(page.url()).pathname}`).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(0);
  }
}

async function eventTypes(id: string) {
  const result = await withDb((db) =>
    db.query<{ type: string }>("select type from itsupport.ticket_events where ticket_id = $1", [
      id,
    ]),
  );
  return result.rows.map(({ type }) => type);
}

async function activate(page: Page, control: Locator) {
  await focus(page, control);
  await page.keyboard.press("Enter");
}

test("T5.E.02 and T5.X.01: staff journey with keyboard and narrow-screen axe checks", async ({
  page,
  request,
}) => {
  await page.goto(base + "/staff/login");
  await audit(page);
  await keyboardLogin(page, admin);
  await audit(page);

  await activate(page, page.getByRole("combobox", { name: "Priority" }));
  const p2 = page.getByRole("option", { name: "P2", exact: true });
  await expect(p2).toBeVisible();
  for (let arrow = 0; arrow < 6; arrow++) {
    if (await p2.evaluate((node) => document.activeElement === node)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(p2).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/[?&]priority=P2/);
  const row = page.getByRole("row").filter({ hasText: title });
  await activate(page, row.getByRole("link"));
  await expect(page).toHaveURL(base + ticketPath);
  await audit(page);

  await focus(page, page.getByLabel("Note", { exact: true }));
  await page.keyboard.insertText("Printer inspection completed");
  await activate(page, page.getByRole("button", { name: "Add note" }));
  await expect(page.getByText("Printer inspection completed", { exact: true })).toBeVisible();
  const assignee = page.getByRole("combobox", { name: "Assignee", exact: true });
  await focus(page, assignee);
  await page.keyboard.press("ArrowDown");
  await expect(assignee).toHaveValue(admin.staffId!);
  await activate(page, page.getByRole("button", { name: "Assign ticket" }));
  await expect(page.getByText("Assigned to Test admin", { exact: true })).toBeVisible();
  const state = page.getByRole("combobox", { name: "Next state", exact: true });
  await focus(page, state);
  await page.keyboard.press("ArrowDown");
  await expect(state).toHaveValue("in_progress");
  await activate(page, page.getByRole("button", { name: "Change state" }));
  await expect(page.getByText("Staff state changed", { exact: true })).toBeVisible();
  expect(await eventTypes(ticket)).toEqual(
    expect.arrayContaining(["staff_note_added", "staff_assigned", "staff_state_changed"]),
  );

  const review = await request.post(base + "/api/internal/test-tickets", {
    headers: { authorization: `Bearer ${stack.internalToken}` },
    data: {
      testId: "staff-suite-admin-review",
      name: "Suite Requester",
      email: "suite-review@example.test",
      department: "Finance",
      title: "Complaint about my team lead",
      description: "I want to raise an HR complaint about harassment by my team lead.",
    },
  });
  expect(review.status()).toBe(201);
  const { ticketId } = (await review.json()) as { ticketId: string };
  await expect.poll(() => eventTypes(ticketId), { timeout: 30_000 }).toContain("review_requested");
  await page.goto(`${base}/staff/tickets/${ticketId}`);
  await activate(page, page.getByRole("button", { name: "Approve", exact: true }));
  await expect.poll(() => eventTypes(ticketId), { timeout: 30_000 }).toContain("review_decided");
  const { rows } = await withDb((db) =>
    db.query("select decision, staff_id from itsupport.reviews where ticket_id = $1", [ticketId]),
  );
  expect(rows).toEqual([{ decision: "approve", staff_id: admin.staffId }]);

  await activate(page, page.getByRole("link", { name: "Back to tickets" }));
  await activate(page, page.getByRole("button", { name: "Sign out" }));
  await expect(page).toHaveURL(base + "/staff/login");
  await page.goto(base + ticketPath);
  await expect(page).toHaveURL(base + "/staff/login");
});

test("T5.S.05: 30 markup fixtures remain text in staff ticket titles and descriptions", async ({
  page,
}) => {
  const signal = "STAFF_RENDER_FIXTURE";
  const wrappers = [
    (marker: string) => "<script>console.log('" + marker + "')</script>",
    (marker: string) => '<img alt="' + marker + '">',
    (marker: string) => '<a href="#fixture">' + marker + "</a>",
    (marker: string) => '<svg aria-label="' + marker + '"></svg>',
    (marker: string) => '<strong data-fixture="' + marker + '">' + marker + "</strong>",
  ];
  const fixtures = Array.from({ length: 30 }, (_, index) => ({
    id: randomUUID(),
    text: wrappers[index % wrappers.length]!(signal + "_" + index),
  }));
  await withDb(async (db) => {
    for (const { id, text } of fixtures) {
      await db.query(
        "insert into itsupport.tickets (id, source, raw_title, raw_description, requester_email, idempotency_key) values ($1::uuid, 'web', $2, $2, 'staff-fixture@example.test', $1::uuid::text)",
        [id, text],
      );
      await db.query(
        "insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description) values ($1, $2, $2)",
        [id, text],
      );
    }
  });

  const signals: string[] = [];
  page.on("dialog", async (dialog) => {
    signals.push("dialog");
    await dialog.dismiss();
  });
  page.on("console", (message) => {
    if (message.text().includes(signal)) signals.push("console");
  });
  await keyboardLogin(page, admin);
  for (const { id, text } of fixtures) {
    const response = await page.goto(base + "/staff/tickets/" + id);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main header p")).toHaveText(text);
    await expect(page.getByRole("region", { name: "Description" }).locator("p")).toHaveText(text);
  }
  expect(signals).toEqual([]);
});
