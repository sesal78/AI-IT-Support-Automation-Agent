// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The script load is cached per module, so each test gets a fresh copy.
let TurnstileWidget: typeof import("./turnstile-widget").TurnstileWidget;
beforeEach(async () => {
  vi.resetModules();
  ({ TurnstileWidget } = await import("./turnstile-widget"));
});

function scriptTag() {
  return document.head.querySelector<HTMLScriptElement>(
    'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]',
  );
}

function fakeApi() {
  return { render: vi.fn(() => "widget-1"), reset: vi.fn(), remove: vi.fn() };
}

afterEach(() => {
  cleanup();
  delete window.turnstile;
  document.head.innerHTML = "";
});

describe("TurnstileWidget", () => {
  it("loads Cloudflare's script on the client and renders with the site key", async () => {
    const onToken = vi.fn();
    render(<TurnstileWidget siteKey="site-key" onToken={onToken} resetSignal={0} />);
    const container = screen.getByTestId("turnstile");
    expect(container.getAttribute("data-sitekey")).toBe("site-key");
    expect(container.getAttribute("data-token-ready")).toBe("false");

    const api = fakeApi();
    await act(async () => {
      window.turnstile = api;
      scriptTag()!.dispatchEvent(new Event("load"));
    });
    expect(api.render).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ sitekey: "site-key", theme: "auto" }),
    );

    const options = (api.render.mock.calls[0] as unknown[])[1] as {
      callback: (token: string) => void;
      "error-callback": () => void;
    };
    act(() => options.callback("token-1"));
    expect(onToken).toHaveBeenLastCalledWith("token-1");
    expect(container.getAttribute("data-token-ready")).toBe("true");
    act(() => options["error-callback"]());
    expect(onToken).toHaveBeenLastCalledWith("");
  });

  it("shows a message and does not throw when the script fails to load", async () => {
    render(<TurnstileWidget siteKey="site-key" onToken={vi.fn()} resetSignal={0} />);
    await act(async () => {
      scriptTag()!.dispatchEvent(new Event("error"));
    });
    expect(screen.getByRole("status").textContent).toMatch(/could not load/);
  });

  it("treats a script without the turnstile global as a failed load", async () => {
    render(<TurnstileWidget siteKey="site-key" onToken={vi.fn()} resetSignal={0} />);
    await act(async () => {
      scriptTag()!.dispatchEvent(new Event("load"));
    });
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("resets on a new signal and removes the widget on unmount", async () => {
    const api = fakeApi();
    window.turnstile = api;
    const { rerender, unmount } = await act(async () =>
      render(<TurnstileWidget siteKey="site-key" onToken={vi.fn()} resetSignal={0} />),
    );
    rerender(<TurnstileWidget siteKey="site-key" onToken={vi.fn()} resetSignal={1} />);
    expect(api.reset).toHaveBeenCalledWith("widget-1");
    unmount();
    expect(api.remove).toHaveBeenCalledWith("widget-1");
  });
});
