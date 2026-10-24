import { countSecurityEvent } from "@/lib/internal/auth";

// The same stable copy of Next's unknown-route 404 as the test-tickets route.
const NOT_FOUND_HTML =
  '<!DOCTYPE html><html><head><meta charSet="utf-8"/><title>404: This page could not be found.</title></head>' +
  "<body><h1>404</h1><h2>This page could not be found.</h2></body></html>";

/**
 * Outside E2E mode an e2e-only route does not exist: the same 404 as an
 * unknown route, before the token is looked at. The probe is counted as a
 * security event (path and method only, retried once on failure); if counting
 * fails the answer is still 404.
 */
export async function e2eOnlyNotFound(request: Request, kind: string): Promise<Response> {
  await countSecurityEvent(kind, request);
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-cache, no-store, max-age=0, must-revalidate",
    },
  });
}
