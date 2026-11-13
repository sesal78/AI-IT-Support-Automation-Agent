import { requireStaff } from "@/lib/staff/auth";

// The guard reads cookies and the database, so this route is always dynamic.
export const dynamic = "force-dynamic";

/**
 * The protected landing (P5-T16). The ticket table is B10 and deliberately not
 * built here: this page proves a signed-in active staff member reaches a
 * guarded screen, and nothing reaches it otherwise. The guard call is the
 * static test's requirement; the proxy's 404 gate runs before this.
 */
export default async function StaffTicketsPage() {
  const { staff } = await requireStaff();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-4 py-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
            IT support
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Tickets</h1>
        </div>
        <form action="/staff/logout" method="post">
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Sign out
          </button>
        </form>
      </header>
      <section className="rounded-lg border border-border p-6">
        <p className="text-sm text-muted-foreground">
          Signed in as {staff.displayName} ({staff.role}).
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          The ticket list and ticket pages arrive with the next tasks.
        </p>
      </section>
    </main>
  );
}
