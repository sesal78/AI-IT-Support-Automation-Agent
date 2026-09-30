"use client";

import { useEffect, useRef, useState } from "react";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileRenderOptions {
  sitekey: string;
  theme?: "auto" | "light" | "dark";
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

interface TurnstileApi {
  render: (container: HTMLElement, options: TurnstileRenderOptions) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoad: Promise<TurnstileApi> | undefined;

// Adds Cloudflare's script once, on the client only. A failed load is
// forgotten so a later mount can try again.
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing"));
    script.onerror = () => reject(new Error("turnstile load failed"));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    scriptLoad = undefined;
    throw error;
  });
  return scriptLoad;
}

export interface TurnstileWidgetProps {
  siteKey: string;
  /** Called with a fresh token, or "" when the token expires or fails. */
  onToken: (token: string) => void;
  /** Change this value to get a new token (tokens are single use). */
  resetSignal: number;
  describedById?: string;
}

export function TurnstileWidget({
  siteKey,
  onToken,
  resetSignal,
  describedById,
}: TurnstileWidgetProps) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const onTokenRef = useRef(onToken);
  const [token, setToken] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    onTokenRef.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let cancelled = false;
    const update = (value: string) => {
      setToken(value);
      onTokenRef.current(value);
    };
    loadTurnstile().then(
      (turnstile) => {
        if (cancelled || !container.current) return;
        widgetId.current = turnstile.render(container.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: update,
          "expired-callback": () => update(""),
          "error-callback": () => update(""),
        });
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (widgetId.current !== undefined) window.turnstile?.remove(widgetId.current);
      widgetId.current = undefined;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetSignal === 0 || widgetId.current === undefined) return;
    setToken("");
    window.turnstile?.reset(widgetId.current);
  }, [resetSignal]);

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={container}
        data-testid="turnstile"
        data-sitekey={siteKey}
        data-token-ready={token !== "" ? "true" : "false"}
        aria-describedby={describedById}
        className="min-h-[65px]"
      />
      {loadFailed ? (
        <p className="text-sm text-destructive" role="status">
          The security check could not load. Check your connection, then reload the page.
        </p>
      ) : null}
    </div>
  );
}
