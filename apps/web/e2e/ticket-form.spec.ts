import { expect, test, type Page } from "@playwright/test";

// Cloudflare's published always-pass Turnstile test site key, also set as
// TURNSTILE_SITE_KEY for the web server in playwright.config.ts.
const TEST_SITE_KEY = `1x${"0".repeat(20)}AA`;
const TICKET_ID = "3f0c9a1e-7b2d-4c55-9e1a-2b8f6d4c1a90";
const STUB_TOKEN = "e2e-turnstile-token";

// Stands in for challenges.cloudflare.com so the tests never use the network:
// render() records the site key and hands back a token like the real widget.
const turnstileStub = `
window.turnstile = {
  render: function (el, opts) {
    el.setAttribute("data-stub-sitekey", opts.sitekey);
    setTimeout(function () { opts.callback(${JSON.stringify(STUB_TOKEN)}); }, 0);
    return "e2e-widget";
  },
  reset: function () {},
  remove: function () {},
};`;

let consoleErrors: string[];

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: turnstileStub }),
  );
});

async function fillAll(page: Page, overrides: Partial<Record<string, string>> = {}) {
  const values = {
    Name: "Jo Tester",
    Email: "jo@example.com",
    Department: "Finance",
    Title: "Laptop will not boot",
    Description: "My laptop shows a black screen after the logo.",
    ...overrides,
  };
  for (const [label, value] of Object.entries(values)) {
    await page.getByLabel(label, { exact: true }).fill(value ?? "");
  }
}

async function waitForToken(page: Page) {
  await expect(page.getByTestId("turnstile")).toHaveAttribute("data-token-ready", "true");
}

test("every input is reachable by its label", async ({ page }) => {
  await page.goto("/");
  for (const label of ["Name", "Email", "Department", "Title", "Description"]) {
    await expect(page.getByLabel(label, { exact: true })).toBeEditable();
  }
});

test("the Turnstile container uses the test site key", async ({ page }) => {
  await page.goto("/");
  const container = page.getByTestId("turnstile");
  await expect(container).toBeAttached();
  await expect(container).toHaveAttribute("data-sitekey", TEST_SITE_KEY);
  await expect(container).toHaveAttribute("data-stub-sitekey", TEST_SITE_KEY);
  expect(consoleErrors).toEqual([]);
});

test("a successful submit shows Ticket received and the ticket ID", async ({ page }) => {
  let sent: Record<string, unknown> | undefined;
  await page.route("**/api/tickets", async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { ticketId: TICKET_ID, queued: true } });
  });
  await page.goto("/");
  await waitForToken(page);
  await fillAll(page);
  await page.getByRole("button", { name: "Submit ticket" }).click();

  await expect(page.getByText("Ticket received")).toBeVisible();
  await expect(page.getByText(TICKET_ID)).toBeVisible();
  expect(sent).toMatchObject({
    name: "Jo Tester",
    email: "jo@example.com",
    department: "Finance",
    title: "Laptop will not boot",
    turnstileToken: STUB_TOKEN,
  });
  expect(consoleErrors).toEqual([]);
});

test("an empty title shows a field error under Title and sends no request", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/tickets", async (route) => {
    requests += 1;
    await route.fulfill({ status: 201, json: { ticketId: TICKET_ID, queued: true } });
  });
  await page.goto("/");
  await waitForToken(page);
  await fillAll(page, { Title: "" });
  await page.getByRole("button", { name: "Submit ticket" }).click();

  const title = page.getByLabel("Title", { exact: true });
  await expect(title).toHaveAttribute("aria-invalid", "true");
  const describedBy = await title.getAttribute("aria-describedby");
  expect(describedBy).toContain("title-error");
  await expect(page.locator("#title-error")).toBeVisible();
  await expect(page.locator("#title-error")).not.toBeEmpty();
  expect(requests).toBe(0);
});

test("a 400 from the server shows its field errors", async ({ page }) => {
  await page.route("**/api/tickets", (route) =>
    route.fulfill({
      status: 400,
      json: { error: "invalid_body", fieldErrors: { title: ["Title is not allowed"] } },
    }),
  );
  await page.goto("/");
  await waitForToken(page);
  await fillAll(page);
  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expect(page.locator("#title-error")).toHaveText("Title is not allowed");
});

test("a 429 shows a Too many requests message", async ({ page }) => {
  await page.route("**/api/tickets", (route) =>
    route.fulfill({ status: 429, json: { error: "rate_limited" } }),
  );
  await page.goto("/");
  await waitForToken(page);
  await fillAll(page);
  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Too many requests" })).toBeVisible();
});

test("a 403 asks the user to redo the security check", async ({ page }) => {
  await page.route("**/api/tickets", (route) =>
    route.fulfill({ status: 403, json: { error: "turnstile_failed" } }),
  );
  await page.goto("/");
  await waitForToken(page);
  await fillAll(page);
  await page.getByRole("button", { name: "Submit ticket" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /security check/i })).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`renders in ${colorScheme} mode without console errors`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "IT Support" })).toBeVisible();
    await waitForToken(page);
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // Light pages use a light background and dark pages a dark one.
    const lightness = await page.evaluate((color) => {
      const el = document.createElement("div");
      el.style.color = color;
      document.body.appendChild(el);
      const canvas = document.createElement("canvas").getContext("2d")!;
      canvas.fillStyle = getComputedStyle(el).color;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
      el.remove();
      return (r + g + b) / 3;
    }, background);
    if (colorScheme === "light") expect(lightness).toBeGreaterThan(200);
    else expect(lightness).toBeLessThan(60);
    expect(consoleErrors).toEqual([]);
  });
}
