// Validates env at server boot by importing the env module. Next.js only logs
// an error thrown from register() and keeps serving, so exit non-zero instead;
// the logged message names each invalid variable (never its value).
export async function validateEnvAtBoot() {
  try {
    await import("./env");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
