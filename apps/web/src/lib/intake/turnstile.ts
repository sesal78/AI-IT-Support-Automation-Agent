export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface VerifyOptions {
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Verifies a Turnstile token server-side. Fails closed: any network error,
 * non-2xx status or malformed body counts as a failed challenge.
 */
export async function verifyTurnstile(
  token: string,
  remoteIp: string | null,
  { secret, fetchImpl = fetch, timeoutMs = 5000 }: VerifyOptions,
): Promise<boolean> {
  if (token === "") return false;
  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp !== null) form.set("remoteip", remoteIp);
  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const data: unknown = await res.json();
    return typeof data === "object" && data !== null && "success" in data && data.success === true;
  } catch {
    return false;
  }
}
