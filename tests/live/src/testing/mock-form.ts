import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { TURNSTILE_TEST_TOKEN } from "../pipeline.ts";
import type { MockE2eOptions } from "./mock-e2e.ts";

/** What the second origin saw of one request. Header values are never stored. */
export interface AssetRequest {
  readonly path: string;
  readonly hasAccessClientId: boolean;
  readonly hasAccessClientSecret: boolean;
}

export interface AssetOrigin {
  /** `http://127.0.0.1:<port>`, a different origin from the mock e2e app. */
  readonly origin: string;
  readonly requests: AssetRequest[];
  close(): Promise<void>;
}

/**
 * The mock page's third-party script (it stands in for Turnstile): it hands
 * the form a token and marks the widget ready, like the real widget.
 */
const TURNSTILE_STUB = `
window.mockTurnstileToken = ${JSON.stringify(TURNSTILE_TEST_TOKEN)};
document.addEventListener("DOMContentLoaded", function () {
  document.querySelector('[data-testid="turnstile"]').setAttribute("data-token-ready", "true");
});`;

/** A second local origin that serves the stub script and records which headers reached it. */
export async function startAssetOrigin(): Promise<AssetOrigin> {
  const requests: AssetRequest[] = [];
  const server = createServer((incoming, response) => {
    requests.push({
      path: new URL(incoming.url ?? "/", "http://127.0.0.1").pathname,
      hasAccessClientId: incoming.headers["cf-access-client-id"] !== undefined,
      hasAccessClientSecret: incoming.headers["cf-access-client-secret"] !== undefined,
    });
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.end(TURNSTILE_STUB);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((closed, fail) => {
        server.closeAllConnections();
        server.close((error) => (error ? fail(error) : closed()));
      }),
  };
}

/**
 * A ticket form with the labels, button, Turnstile container and receipt of
 * the real page (apps/web `ticket-form.tsx`). It loads its script from
 * `assetOrigin` and posts to `/api/tickets` on its own origin.
 */
export function mockFormPage(assetOrigin: string): string {
  const field = (id: string, label: string) =>
    `<label for="${id}">${label}</label><input id="${id}" name="${id}">`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>IT support</title>
<script src="${new URL("/turnstile.js", assetOrigin).toString()}"></script></head>
<body><main id="app">
<form aria-label="New IT support ticket" id="ticket" novalidate>
${field("name", "Name")}${field("email", "Email")}${field("department", "Department")}${field("title", "Title")}
<label for="description">Description</label><textarea id="description" name="description"></textarea>
<div data-testid="turnstile" data-token-ready="false"></div>
<button type="submit">Submit ticket</button>
</form></main>
<script>
document.getElementById("ticket").addEventListener("submit", function (event) {
  event.preventDefault();
  var value = function (id) { return document.getElementById(id).value; };
  var body = {
    name: value("name"), email: value("email"), department: value("department"),
    title: value("title"), description: value("description"),
    turnstileToken: window.mockTurnstileToken,
  };
  fetch("/api/tickets", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(function (r) { return r.json(); }).then(function (json) {
    var app = document.getElementById("app");
    app.textContent = "";
    var status = document.createElement("div");
    status.setAttribute("role", "status");
    var heading = document.createElement("h2");
    heading.textContent = "Ticket received";
    var id = document.createElement("p");
    id.textContent = json.ticketId;
    status.append(heading, id);
    app.append(status);
  });
});
</script></body></html>`;
}

/**
 * A mock e2e `override` that serves the form page at `/` behind the Access
 * gate: a request without the right Access headers falls through to the
 * default 403.
 */
export function serveFormPage(assetOrigin: string): NonNullable<MockE2eOptions["override"]> {
  const html = mockFormPage(assetOrigin);
  return (request) =>
    request.method === "GET" && request.path === "/" && request.accessOk
      ? { status: 200, text: html, contentType: "text/html; charset=utf-8" }
      : undefined;
}
