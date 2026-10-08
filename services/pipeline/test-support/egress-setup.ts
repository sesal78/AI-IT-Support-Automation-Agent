// Setup file for every pipeline integration test file (P3-T12a): starts the
// egress recorder, fails the test when a request leaked PII, and always clears
// the records so a leak is reported once, on the test that made it.
import { afterAll, afterEach } from "vitest";
import { egress } from "./egress.js";

// Top level, not beforeAll: setup files run before the test file's imports, so a
// client that stores `fetch` when it is built still gets the patched one.
egress.start();
afterEach(() => {
  try {
    egress.assertClean();
  } finally {
    egress.reset();
  }
});
afterAll(() => egress.stop());
