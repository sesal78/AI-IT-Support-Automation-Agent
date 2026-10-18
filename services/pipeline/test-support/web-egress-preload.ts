// HTTP mocks for the web server process of the local end-to-end test (P3-T10h).
// TEST CODE ONLY: never import it from `src`. The Playwright stack loads it into
// `next start` with `NODE_OPTIONS=--import <file URL>` (Node strips the types),
// so the web app runs unchanged.
//
// It starts the egress recorder before Next.js loads, answers Turnstile
// siteverify (success for the configured secret and any non-empty token) and
// the TypeSafe, LLM and Langfuse hosts (canned answers), and blocks every other
// host that is not 127.0.0.1. The parent process talks to it over the IPC
// channel of the child process:
//   { type: "forbid", value }  registers a string that must never leave the process
//   { type: "check" }          replies { type: "egress", problems: string[] }
// A problem names a method, a host and a finding type, never a value.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

// The test-support sources import siblings as `./x.js` (NodeNext style) while the
// files are `.ts`. Without a bundler, map such a specifier to the `.ts` file
// when only that exists. Bare and absolute specifiers are left alone.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const asJs = new URL(specifier, context.parentURL);
      const asTs = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);
      if (asJs.protocol === "file:" && !existsSync(asJs) && existsSync(asTs)) {
        return nextResolve(asTs.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { HttpResponse } = await import("msw");
const { createEgressRecorder } =
  await import("../../../packages/shared/test-support/egress-recorder.js");
const { mockProviders } = await import("./provider-mocks.js");

const SITEVERIFY_ORIGIN = "https://challenges.cloudflare.com";

const recorder = createEgressRecorder();
recorder.start();
mockProviders(recorder);
recorder.mock(SITEVERIFY_ORIGIN, async ({ request }) => {
  const form = new URLSearchParams(await request.text());
  const success =
    form.get("secret") === process.env.TURNSTILE_SECRET_KEY && (form.get("response") ?? "") !== "";
  return HttpResponse.json({ success, "error-codes": success ? [] : ["invalid-input-response"] });
});

type ParentMessage = { type?: unknown; value?: unknown };

process.on("message", (message: ParentMessage) => {
  if (message?.type === "forbid" && typeof message.value === "string") {
    recorder.forbid(message.value);
  } else if (message?.type === "check") {
    let problems: string[] = [];
    try {
      recorder.assertClean();
    } catch (error) {
      problems = String((error as Error).message)
        .split("\n")
        .slice(1);
    }
    process.send?.({ type: "egress", problems, requests: recorder.requests().length });
  }
});
