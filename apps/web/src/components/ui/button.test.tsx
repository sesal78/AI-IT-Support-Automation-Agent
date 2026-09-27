import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("shadcn Button", () => {
  it("renders a button with variant and size data attributes", () => {
    const html = renderToStaticMarkup(
      <Button variant="outline" size="sm">
        Go
      </Button>,
    );
    expect(html).toMatch(/^<button/);
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain('data-size="sm"');
  });

  it("renders its child element when asChild is set", () => {
    const html = renderToStaticMarkup(
      <Button asChild>
        <a href="/x">Link</a>
      </Button>,
    );
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/x"');
  });
});
