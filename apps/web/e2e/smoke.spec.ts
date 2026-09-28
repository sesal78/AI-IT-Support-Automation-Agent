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
