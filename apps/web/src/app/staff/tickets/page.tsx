import Link from "next/link";
import type { HelpdeskState, Priority } from "@ai-it-support/shared";
import { env } from "@/env";
import { requireStaff } from "@/lib/staff/auth";
import {
  buildTicketListHref,
  parseTicketListQuery,
  type TicketListFilters,
} from "@/lib/staff/ticket-list-filters";
import { listStaffTickets, type StaffTicketRow } from "@/lib/staff/ticket-list-query";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "cn";
import { TicketFilters } from "./ticket-filters";

// The guard reads cookies and the database, and the list reads the query
// string, so this route is always dynamic.
export const dynamic = "force-dynamic";

interface StaffTicketsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The staff ticket list (P5-T17). Reads with the signed-in staff member's own
 * JWT only (row-level security is the control; the service role is never
 * used). The ticket page (B11) and staff actions (B12) are not built here.
 */
export default async function StaffTicketsPage({ searchParams }: StaffTicketsPageProps) {
  const { staff } = await requireStaff();
  const rawParams = await searchParams;
  const { filters, invalid } = parseTicketListQuery(rawParams, { e2eMode: env.E2E_MODE });
  const supabase = await createServerSupabaseClient();
  const list = await listStaffTickets(supabase, filters);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
            IT support
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Tickets</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {staff.displayName} ({staff.role}).
          </p>
        </div>
        <form action="/staff/logout" method="post">
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted dark:border-input"
          >
            Sign out
          </button>
        </form>
      </header>

      {invalid && (
        <Alert variant="destructive">
          <AlertTitle>Some filters were not understood</AlertTitle>
          <AlertDescription>Showing the unfiltered ticket list instead.</AlertDescription>
        </Alert>
      )}

      <TicketFilters
        status={filters.status}
        priority={filters.priority}
        category={filters.category}
      />

      <TicketListTable rows={list.rows} />

      <Pagination
        filters={filters}
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
      />
    </main>
  );
}

function TicketListTable({ rows }: { rows: StaffTicketRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-border p-6 text-sm text-muted-foreground dark:border-input">
        No tickets match this view.
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Number</TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Pipeline status</TableHead>
          <TableHead>Helpdesk state</TableHead>
          <TableHead>Priority</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Assignee</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Link href={`/staff/tickets/${row.id}`} className="flex flex-col hover:underline">
                <span className="font-mono text-sm">{row.ticketNumber}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {row.helpdeskNumber ?? "—"}
                </span>
              </Link>
            </TableCell>
            <TableCell className="max-w-64 truncate whitespace-normal">
              {row.redactedTitle ?? "—"}
            </TableCell>
            <TableCell>
              <Badge variant="muted">{humanize(row.pipelineStatus)}</Badge>
            </TableCell>
            <TableCell>
              {row.helpdeskState ? (
                <Badge variant={helpdeskStateVariant(row.helpdeskState)}>
                  {humanize(row.helpdeskState)}
                </Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell>
              {row.priority ? (
                <Badge variant={priorityVariant(row.priority)}>{row.priority}</Badge>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell>
              {row.category ? <Badge variant="outline">{humanize(row.category)}</Badge> : "—"}
            </TableCell>
            <TableCell>{row.assigneeName ?? "—"}</TableCell>
            <TableCell>{formatCreatedAt(row.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Pagination({
  filters,
  page,
  pageCount,
  total,
}: {
  filters: TicketListFilters;
  page: number;
  pageCount: number;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        Page {page} of {pageCount} · {total} ticket{total === 1 ? "" : "s"}
      </p>
      <div className="flex gap-2">
        <PageLink filters={filters} page={page - 1} enabled={page > 1} label="Previous" />
        <PageLink filters={filters} page={page + 1} enabled={page < pageCount} label="Next" />
      </div>
    </div>
  );
}

function PageLink({
  filters,
  page,
  enabled,
  label,
}: {
  filters: TicketListFilters;
  page: number;
  enabled: boolean;
  label: string;
}) {
  const classes = cn(
    buttonVariants({ variant: "outline", size: "sm" }),
    !enabled && "pointer-events-none opacity-50",
  );
  if (!enabled) {
    return (
      <span className={classes} aria-disabled="true">
        {label}
      </span>
    );
  }
  return (
    <Link href={buildTicketListHref(filters, page)} className={classes}>
      {label}
    </Link>
  );
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function priorityVariant(priority: Priority): "destructive" | "default" | "secondary" {
  if (priority === "P1") return "destructive";
  if (priority === "P2") return "default";
  return "secondary";
}

function helpdeskStateVariant(state: HelpdeskState): "default" | "secondary" | "muted" {
  if (state === "closed") return "muted";
  if (state === "resolved") return "secondary";
  return "default";
}

function formatCreatedAt(iso: string): string {
  return iso.slice(0, 10);
}
