// A sleeping personal developer instance answers with an HTML page or a redirect
// to the developer portal. Both are "asleep"; a 503 never is.
const HIBERNATION_MARKER = /instance\s+hibernating/i;
const PORTAL_HOST = "developer.servicenow.com";

/** True when a non-JSON body is the hibernation page. */
export function isHibernationPage(body: string): boolean {
  return HIBERNATION_MARKER.test(body);
}

/** True when a redirect Location points at the developer portal. */
export function isHibernationRedirect(location: string | null, instanceUrl: string): boolean {
  if (location === null) return false;
  try {
    return new URL(location, instanceUrl).hostname.toLowerCase() === PORTAL_HOST;
  } catch {
    return false;
  }
}
