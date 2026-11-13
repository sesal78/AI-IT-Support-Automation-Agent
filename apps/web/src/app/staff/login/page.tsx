import { LoginForm } from "./login-form";

// Rendered per request so the session cookies are read at run time (Dokploy
// sets env on the container, not at build time).
export const dynamic = "force-dynamic";

/**
 * The one public staff screen (P5-T16, G7). It has no `requireStaff` call by
 * design: an unauthenticated user must reach it. Sign-up, password reset and
 * magic links do not exist.
 */
export default function StaffLoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-8 px-4 py-16">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
          IT support
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Staff sign in</h1>
      </header>
      <LoginForm />
    </main>
  );
}
