import type { FormBrowser } from "./browser-form.ts";

/** How long the page may take to show the ticket ID after the click. */
const RECEIPT_TIMEOUT_MS = 30_000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The extra headers for one browser request: the Access headers when its URL
 * has exactly the E2E origin, none for any other origin (or a bad URL).
 */
export function headersForRequest(
  url: string,
  origin: string,
  accessHeaders: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  let requestOrigin: string;
  try {
    requestOrigin = new URL(url).origin;
  } catch {
    return {};
  }
  return requestOrigin === origin ? accessHeaders : {};
}

/**
 * The real form browser: headless Chromium through Playwright, loaded only
 * when a submit runs (so the Vitest gate never needs a browser).
 *
 * The Access headers are added per request, only when the request URL has
 * the E2E origin; `setExtraHTTPHeaders` would send them everywhere. Such a
 * request is fetched here with no redirect followed (`maxRedirects: 0`), so
 * the headers never ride a redirect to another origin: the browser follows
 * the 30x itself, as a new routed request. Service workers are blocked, as
 * their requests would skip the route.
 */
export function createPlaywrightFormBrowser(
  options: {
    /**
     * Grants Local Network Access. Only for the mock: a fulfilled page has no
     * address space, so Chromium blocks its requests to a second 127.0.0.1
     * origin. The real page loads only public resources.
     */
    readonly allowLocalNetwork?: boolean;
  } = {},
): FormBrowser {
  return {
    async submit({ origin, accessHeaders, values, beforeSubmit }) {
      const { chromium } = await import("@playwright/test");
      const browser = await chromium.launch();
      try {
        const browserContext = await browser.newContext({
          serviceWorkers: "block",
          permissions: options.allowLocalNetwork === true ? ["local-network-access"] : [],
        });
        await browserContext.route("**/*", async (route) => {
          const request = route.request();
          const extra = headersForRequest(request.url(), origin, accessHeaders);
          if (Object.keys(extra).length === 0) return route.continue();
          const response = await route.fetch({
            headers: { ...request.headers(), ...extra },
            maxRedirects: 0,
          });
          return route.fulfill({ response });
        });
        const page = await browserContext.newPage();
        await page.goto(new URL("/", origin).toString());
        // The real form only submits once Turnstile has handed over a token.
        await page
          .locator('[data-testid="turnstile"][data-token-ready="true"]')
          .waitFor({ state: "attached" });
        for (const [label, value] of Object.entries(values)) {
          await page.getByLabel(label, { exact: true }).fill(value);
        }
        await beforeSubmit();
        await page.getByRole("button", { name: "Submit ticket" }).click();
        const receipt = page.getByRole("status").filter({ hasText: "Ticket received" });
        await receipt.waitFor({ timeout: RECEIPT_TIMEOUT_MS });
        return { ticketId: UUID.exec(await receipt.innerText())?.[0]?.toLowerCase() ?? null };
      } finally {
        await browser.close();
      }
    },
  };
}
