import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import RootLayout, { metadata } from "./layout";

// next/font is compiled by the Next.js build; stub it for unit tests.
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-sans-var" }),
  Geist_Mono: () => ({ variable: "font-mono-var" }),
}));

describe("root layout", () => {
  it("wraps children in an English html shell with the font variables", () => {
    const html = renderToStaticMarkup(
      <RootLayout params={Promise.resolve({})}>
        <p>child</p>
      </RootLayout>,
    );
    expect(html).toContain('<html lang="en"');
    expect(html).toContain("font-sans-var font-mono-var");
    expect(html).toContain("<p>child</p>");
  });

  it("sets the page title", () => {
    expect(metadata.title).toBe("IT Support Agent");
  });
});
