import { describe, expect, it } from "vitest";
import {
  assertHeaderSafe,
  EmailHeaderError,
  isAllowedRecipient,
  parseRecipient,
} from "./headers.js";

const INJECTION = "carol@example.com\r\nBcc: x@y.com";

describe("assertHeaderSafe", () => {
  it.each(["a\rb", "a\nb", "a\0b", "a\r\nBcc: x@y.com"])("refuses %j, naming the field", (v) => {
    expect(() => assertHeaderSafe(v, "subject")).toThrow(EmailHeaderError);
    expect(() => assertHeaderSafe(v, "subject")).toThrow(/subject/);
  });

  it("refuses a non-string and accepts plain text", () => {
    expect(() => assertHeaderSafe(42, "from")).toThrow(EmailHeaderError);
    expect(() => assertHeaderSafe("Your IT ticket ITS-000042", "subject")).not.toThrow();
  });
});

describe("parseRecipient", () => {
  it("lower-cases one plain address", () => {
    expect(parseRecipient("Carol@Example.com")).toBe("carol@example.com");
  });

  it("T5.U.04: an injected recipient throws EmailHeaderError naming the field, without the value", () => {
    for (const field of ["to", "from"]) {
      let error: unknown;
      try {
        parseRecipient(INJECTION, field);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(EmailHeaderError);
      expect((error as EmailHeaderError).field).toBe(field);
      expect((error as Error).message).toContain(field);
      expect((error as Error).message).not.toContain("Bcc");
    }
  });

  it.each([
    "a@example.com,b@example.com",
    "Carol <carol@example.com>",
    "carol@example.com ",
    "x+carol@example.com",
    "carol@localhost",
    "..@example.com",
    ".a@example.com",
    "a.@example.com",
    "a..b@example.com",
    "a@-example.com",
    "a@example-.com",
    "a@example..com",
    '"a b"@example.com',
    "",
    `${"a".repeat(65)}@example.com`,
  ])("rejects %j", (v) => {
    expect(() => parseRecipient(v)).toThrow(EmailHeaderError);
  });
});

describe("isAllowedRecipient", () => {
  const list = ["carol@example.com"];

  it("matches the normalised address exactly", () => {
    expect(isAllowedRecipient("Carol@Example.com", list)).toBe(true);
  });

  it.each([
    "carol@example.com.evil",
    "x+carol@example.com",
    "carol@example.co",
    INJECTION,
    "carol@example.com,evil@example.com",
  ])("is false for %j", (v) => {
    expect(isAllowedRecipient(v, list)).toBe(false);
  });
});
