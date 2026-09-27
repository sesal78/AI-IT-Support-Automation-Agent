import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("home page", () => {
  it("shows the IT Support heading", () => {
    const html = renderToStaticMarkup(<Home />);
    expect(html).toMatch(/<h1[^>]*>IT Support Agent<\/h1>/);
  });
});
