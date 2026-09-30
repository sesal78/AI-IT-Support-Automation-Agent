import { expect, test } from "@playwright/test";

test("home page shows the IT Support heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "IT Support" })).toBeVisible();
});

test("GET /api/health returns 200", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok" });
});

// An invalid body is rejected before Turnstile, so this makes no network call.
test("POST /api/tickets rejects an invalid body with 400 field errors", async ({ request }) => {
  const res = await request.post("/api/tickets", {
    data: {
      name: "E2E",
      email: "e2e@example.com",
      department: "IT",
      title: "ab",
      description: "long enough description",
      turnstileToken: "x",
    },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).fieldErrors).toHaveProperty("title");
});
