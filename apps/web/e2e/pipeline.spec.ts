import { CATEGORIES, INTAKE_TICKET_TASK_ID, type InternalTicketView } from "@ai-it-support/shared";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { startPipelineStack, type PipelineStack } from "./support/pipeline-stack";

// Local end-to-end test (P3-T10h, T3.E.01): the real form on the built web app
// (E2E_MODE=true) against the local REST stack and the local Trigger.dev runner.
// Every external service is answered locally: siteverify and the providers in
// the web process (egress preload), TypeSafe, the LLM and Langfuse in the runner
// (this worker), and challenges.cloudflare.com in the browser (stub script).
// Any other external request is blocked and fails the test, so the spec needs
// no network. Needs Docker and `pnpm build`.

const TURNSTILE_TOKEN = "e2e-turnstile-token";
const turnstileStub = `
window.turnstile = {
  render: function (el, opts) {
    setTimeout(function () { opts.callback(${JSON.stringify(TURNSTILE_TOKEN)}); }, 0);
    return "e2e-widget";
  },
  reset: function () {},
  remove: function () {},
};`;

const PHONE = "0412 345 678";
const FORM = {
  Name: "Pat Pipeline",
  Email: "pat.pipeline@example.com",
  Department: "Finance",
  Title: "VPN drops every few minutes",
  Description: `The VPN disconnects every few minutes since this morning. Call me on ${PHONE}.`,
};

let stack: PipelineStack | undefined;
let blocked: string[] = [];

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ baseURL }, testInfo) => {
  // Docker image pulls and the REST stack start can take a while on a cold runner.
  testInfo.setTimeout(300_000);
  if (!baseURL) throw new Error("the pipeline project needs a baseURL");
  stack = await startPipelineStack(baseURL);
  for (const value of [FORM.Name, FORM.Email]) {
    stack.forbid(value);
    stack.runner.egress.forbid(value);
  }
});

test.afterAll(async () => {
  await stack?.stop();
});

test.beforeEach(async ({ context }) => {
  blocked = [];
  // Registered first, so the Turnstile route below wins for its host.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1") return route.fallback();
    blocked.push(url.host);
    return route.abort("blockedbyclient");
  });
  await context.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: turnstileStub }),
  );
});

test.afterEach(async () => {
  expect(blocked, "browser requests to hosts with no local mock").toEqual([]);
  if (!stack) return;
  expect(await stack.webEgressProblems(), "web process egress").toEqual([]);
  stack.runner.egress.assertClean();
});

function getStack(): PipelineStack {
  if (!stack) throw new Error("pipeline stack not started");
  return stack;
}

async function submitForm(page: Page): Promise<string> {
  await page.goto("/");
  await expect(page.getByTestId("turnstile")).toHaveAttribute("data-token-ready", "true");
  for (const [label, value] of Object.entries(FORM)) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole("button", { name: "Submit ticket" }).click();
  const received = page.getByRole("status");
  await expect(received.getByText("Ticket received")).toBeVisible();
  const id = received.getByText(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  await expect(id).toBeVisible();
  return (await id.innerText()).trim();
}

async function getView(request: APIRequestContext, id: string, token: string) {
  return request.get(`/api/internal/tickets/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function viewOf(request: APIRequestContext, id: string): Promise<InternalTicketView> {
  const res = await getView(request, id, getStack().internalToken);
  expect(res.status()).toBe(200);
  return (await res.json()) as InternalTicketView;
}

let ticketId = "";

test("T3.E.01: the form creates a ticket that reaches triaged within 30 s", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  ticketId = await submitForm(page);

  await expect
    .poll(async () => (await viewOf(request, ticketId)).status, { timeout: 30_000 })
    .toBe("triaged");

  const res = await getView(request, ticketId, getStack().internalToken);
  const text = await res.text();
  const view = JSON.parse(text) as InternalTicketView;
  expect(view.isTest).toBe(true);
  expect(CATEGORIES).toContain(view.triage?.category);
  const steps = (view.triage?.suggestedFix as { steps?: unknown } | null)?.steps;
  expect(Array.isArray(steps) && steps.length).toBeGreaterThanOrEqual(1);

  const types = view.events.map((event) => event.type);
  const redacted = types.indexOf("redacted");
  expect(redacted).toBeGreaterThanOrEqual(0);
  expect(types.indexOf("triaged")).toBeGreaterThan(redacted);

  // The phone number is redacted; the requester's name and email never appear.
  expect(view.redacted?.description).toContain("[REDACTED_PHONE]");
  expect(view.redacted?.description).not.toContain(PHONE);
  expect(text).not.toContain(PHONE);
  expect(text.toLowerCase()).not.toContain(FORM.Name.toLowerCase());
  expect(text.toLowerCase()).not.toContain(FORM.Email.toLowerCase());
});

test("the ticket view refuses a wrong token with 401", async ({ request }) => {
  expect(ticketId).not.toBe("");
  const res = await getView(request, ticketId, "w".repeat(32));
  expect(res.status()).toBe(401);
});

test("submitting the same form again the same day returns the same ticket, triaged once", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  expect(ticketId).not.toBe("");
  expect(await submitForm(page)).toBe(ticketId);

  await getStack().runner.idle();
  const view = await viewOf(request, ticketId);
  expect(view.status).toBe("triaged");
  expect(view.events.filter((event) => event.type === "triaged")).toHaveLength(1);
  expect(
    getStack()
      .runner.runs()
      .filter((run) => run.taskId === INTAKE_TICKET_TASK_ID),
  ).toHaveLength(1);
});
