/**
 * A full live env whose every secret is a unique marker, built with
 * `repeat` so no literal secret sits in the source. The token is letters only
 * (the internal token rule); the others carry regex-special characters.
 */
export function markerEnv(origin: string) {
  return {
    E2E_BASE_URL: origin,
    INTERNAL_API_TOKEN: `MarkerToken${"x".repeat(40)}`,
    CF_ACCESS_CLIENT_ID: `MarkerAccessId.*+?^$${"y".repeat(20)}`,
    CF_ACCESS_CLIENT_SECRET: `MarkerAccessSecret(|)[]{}\\${"z".repeat(30)}`,
    LANGFUSE_PUBLIC_KEY: `MarkerLangfusePublic${"p".repeat(20)}`,
    LANGFUSE_SECRET_KEY: `MarkerLangfuseSecret${"s".repeat(20)}`,
    LANGFUSE_BASE_URL: `https://markerlangfuse${"l".repeat(10)}.example`,
    STAGING_BASE_URL: `https://markerstaging${"q".repeat(10)}.example`,
  };
}
