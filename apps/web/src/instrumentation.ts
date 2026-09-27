// Runs once when the Next.js server starts, before it serves requests.
// Node-only code lives in instrumentation-node.ts so the Edge bundle never sees it.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnvAtBoot } = await import("./instrumentation-node");
    await validateEnvAtBoot();
  }
}
