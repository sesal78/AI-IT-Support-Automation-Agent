import { TICKET_STATUSES } from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";
import { checkSync } from "./sync-guard.js";

const RUN = ["auto", "approved", "helpdesk_pending"];
const DONE = ["incident_created", "incident_skipped_shadow"];
const REFUSED = TICKET_STATUSES.filter((status) => ![...RUN, ...DONE].includes(status));

describe("checkSync", () => {
  it.each(RUN)("runs for %s", (status) => {
    expect(checkSync(status)).toBe("run");
  });

  it.each(DONE)("is done for %s", (status) => {
    expect(checkSync(status)).toBe("done");
  });

  it("refuses every other ticket status, nothing is forgotten", () => {
    expect(REFUSED).toEqual([
      "new",
      "redacted",
      "triaged",
      "review_pending",
      "rejected",
      "escalated_manual",
      "failed",
    ]);
    for (const status of REFUSED) expect(checkSync(status)).toBe("refuse");
  });

  it.each(["", "AUTO", " auto", "auto ", "constructor", "__proto__", "toString", "unknown"])(
    "refuses the value %j that is not a ticket status",
    (value) => {
      expect(checkSync(value)).toBe("refuse");
    },
  );

  it.each([undefined, null, 1, {}, ["auto"]])("refuses the non-string %j", (value) => {
    expect(checkSync(value as never)).toBe("refuse");
  });
});
