import { CATEGORIES } from "@ai-it-support/shared";
import { fixSteps, isTriaged, result, waitForTriage } from "./pipeline.ts";
import { createPlaywrightFormBrowser } from "./playwright-form.ts";
import type { Scenario } from "./runner.ts";

/** Plan T3.L.01: the ticket must be `triaged` within 30 s of the submit. */
export const FORM_TRIAGE_LIMIT_MS = 30_000;

/** What the browser types into the form, by field label. */
export interface FormValues {
  readonly Name: string;
  readonly Email: string;
  readonly Department: string;
  readonly Title: string;
  readonly Description: string;
}

export interface FormSubmitOptions {
  /** Origin of E2E_BASE_URL: the page is opened there, and only it gets `accessHeaders`. */
  readonly origin: string;
  readonly accessHeaders: Readonly<Record<string, string>>;
  readonly values: FormValues;
  /** Runs right before the submit click (the pacer). */
  readonly beforeSubmit: () => Promise<void>;
}

/** Fills and submits the ticket form in a browser; returns the ticket ID the page shows. */
export interface FormBrowser {
  submit(options: FormSubmitOptions): Promise<{ ticketId: string | null }>;
}

const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * T3.L.01: a browser opens E2E_BASE_URL, fills the ticket form and submits it
 * (one paced form-path submit), reads the ticket ID, and the ticket view is
 * `triaged` within the limit of the submit, with a category from the 6 and at
 * least 1 fix step. The limit is shortened in tests.
 */
export function createBrowserFormScenario(
  options: { browser?: FormBrowser; triageLimitMs?: number } = {},
): Scenario {
  const browser = options.browser ?? createPlaywrightFormBrowser();
  const limitMs = options.triageLimitMs ?? FORM_TRIAGE_LIMIT_MS;
  return {
    id: "T3.L.01",
    async run(context) {
      let submitAt: number | undefined;
      const { ticketId: shown } = await browser.submit({
        origin: context.config.origin,
        accessHeaders: {
          "CF-Access-Client-Id": context.config.accessClientId,
          "CF-Access-Client-Secret": context.config.accessClientSecret,
        },
        values: {
          Name: "Live Test",
          Email: "live.test@example.com",
          Department: "IT",
          Title: "Laptop will not boot",
          Description: `My laptop shows a black screen after the logo. (live run ${context.runId})`,
        },
        beforeSubmit: async () => {
          await context.pacer.acquire();
          submitAt = context.now();
        },
      });
      const ticketId = shown !== null && TICKET_ID.test(shown) ? shown : null;
      if (ticketId === null || submitAt === undefined) {
        return result(["ticket-id"], { ticketId, formSubmitted: submitAt !== undefined });
      }
      const views = await waitForTriage(context, [{ id: ticketId, deadline: submitAt + limitMs }]);
      const view = views.get(ticketId)!;
      // Server clock: from the ticket's creation (the submit) to its `triaged` event.
      const triagedEvent = view.events.find((event) => event.type === "triaged");
      const msToTriaged =
        isTriaged(view) && triagedEvent !== undefined
          ? Date.parse(triagedEvent.at) - Date.parse(view.createdAt)
          : null;
      const triaged = msToTriaged !== null && msToTriaged <= limitMs;
      const category = view.triage?.category ?? null;
      const steps = fixSteps(view);
      const failedChecks = [
        ...(triaged ? [] : ["triaged-within-limit"]),
        ...(category !== null && (CATEGORIES as readonly string[]).includes(category)
          ? []
          : ["category"]),
        ...(steps >= 1 ? [] : ["fix-steps"]),
      ];
      return result(failedChecks, {
        ticketId,
        status: view.status,
        msToTriaged,
        limitMs,
        category,
        fixSteps: steps,
      });
    },
  };
}

export const browserFormScenario: Scenario = createBrowserFormScenario();
