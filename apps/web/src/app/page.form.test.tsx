import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home, { dynamic } from "./page";

describe("home page ticket form", () => {
  const html = renderToStaticMarkup(<Home />);

  it("is rendered per request so the site key is read at run time", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("passes the run-time site key to the Turnstile container", () => {
    expect(html).toContain('data-testid="turnstile"');
    expect(html).toContain('data-sitekey="fake-turnstile-site-key"');
  });

  it("labels every input", () => {
    for (const [id, label] of [
      ["name", "Name"],
      ["email", "Email"],
      ["department", "Department"],
      ["title", "Title"],
      ["description", "Description"],
    ]) {
      expect(html).toMatch(new RegExp(`<label[^>]*for="${id}"[^>]*>${label}</label>`));
      expect(html).toMatch(new RegExp(`<(input|textarea)[^>]*id="${id}"`));
    }
  });

  it("has a submit button", () => {
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>[^<]*Submit ticket/);
  });
});
