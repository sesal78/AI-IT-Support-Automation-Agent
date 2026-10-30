import { z } from "zod";

/**
 * Test switches an E2E run can attach to a ticket (plan C5). Strict: an
 * unknown switch name is an error, never ignored. `reviewTimeout` (phase 4)
 * is a whole number of minutes from 1 to 60, written like `30m`.
 */
export const testOverridesSchema = z.strictObject({
  llmCallCap: z.number().int().min(0).max(100_000).optional(),
  langfuseDown: z.boolean().optional(),
  reviewTimeout: z
    .string()
    .regex(/^[1-9][0-9]?m$/)
    .refine((value) => Number.parseInt(value, 10) <= 60)
    .optional(),
});

export type TestOverrides = z.infer<typeof testOverridesSchema>;

/** Thrown for a malformed or unknown switch. Carries no input value. */
export class TestOverridesError extends Error {
  override readonly name = "TestOverridesError";
  constructor() {
    super("invalid test overrides");
  }
}

/**
 * The switches that may take effect: the requested ones only when the server
 * runs in E2E mode AND the ticket is a test ticket, otherwise `{}`. The
 * request is validated first, so a bad switch throws even when the result
 * would be `{}`.
 */
export function effectiveTestOverrides(input: {
  e2eMode: boolean;
  isTest: boolean;
  requested?: unknown;
}): TestOverrides {
  let requested: TestOverrides = {};
  if (input.requested !== undefined) {
    const parsed = testOverridesSchema.safeParse(input.requested);
    if (!parsed.success) throw new TestOverridesError();
    requested = parsed.data;
  }
  return input.e2eMode === true && input.isTest === true ? requested : {};
}
