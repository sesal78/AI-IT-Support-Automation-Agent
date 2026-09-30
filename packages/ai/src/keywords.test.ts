import { describe, expect, it } from "vitest";
import { keywordFlags } from "./keywords.js";

describe("keywordFlags", () => {
  it.each([
    ["I need to talk to legal about this", "legal"],
    ["my lawyer asked for the emails", "legal"],
    ["there is a lawsuit pending", "legal"],
    ["please raise it with HR", "hr"],
    ["I am reporting harassment by a colleague", "hr"],
    ["his termination is on Friday", "termination"],
    ["I am being terminated tomorrow, need my files", "termination"],
    ["she was fired yesterday, lock her account", "termination"],
    ["notice of dismissal attached", "termination"],
    ["an executive laptop is broken", "executive"],
    ["the CEO cannot log in", "executive"],
    ["CFO mailbox is full", "executive"],
    ["slides for the board meeting", "executive"],
    ["we think there was a breach", "security_incident"],
    ["ransomware note on the file server", "security_incident"],
    ["I clicked a phishing link", "security_incident"],
    ["possible data leak from the CRM", "security_incident"],
  ])("flags %j as %s", (text, flag) => {
    expect(keywordFlags(text)).toEqual([flag]);
  });

  it("matches case-insensitively", () => {
    expect(keywordFlags("Ceo and hr and RANSOMWARE")).toEqual([
      "hr",
      "executive",
      "security_incident",
    ]);
  });

  it.each([
    ["the printer might throw an error", "HR inside throw"],
    ["my keyboard is broken", "board inside keyboard"],
    ["the dashboard will not load", "board inside dashboard"],
    ["there is a fire drill at 3pm", "fire alone"],
    ["please open a terminal and run the script", "terminal"],
    ["the paralegal team needs a new printer", "legal inside paralegal"],
    ["INC0012345 VPN drops every hour", "plain IT ticket"],
    ["", "empty text"],
  ])("does not flag %j (%s)", (text) => {
    expect(keywordFlags(text)).toEqual([]);
  });

  it("returns each topic once, in the fixed topic order", () => {
    expect(keywordFlags("phishing then lawsuit then phishing and a lawyer")).toEqual([
      "legal",
      "security_incident",
    ]);
  });

  it("works on redacted text around placeholders", () => {
    expect(keywordFlags("[REDACTED_EMAIL] reported a breach")).toEqual(["security_incident"]);
  });
});
