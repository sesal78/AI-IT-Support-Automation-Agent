import { TicketForm } from "@/components/ticket-form";
import { turnstileSiteKey } from "@/lib/intake/site-key";

// Rendered per request so TURNSTILE_SITE_KEY is read at run time (Dokploy sets
// env on the container, not at build time).
export const dynamic = "force-dynamic";

export default function Home() {
  const siteKey = turnstileSiteKey();

  return (
    <main className="mx-auto grid w-full content-start items-start max-w-5xl flex-1 gap-10 px-4 py-10 sm:px-6 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-14 md:py-20">
      <header className="flex flex-col gap-5 md:sticky md:top-20 md:self-start">
        <p className="font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
          Service desk
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          IT Support Agent
        </h1>
        <p className="max-w-sm text-base leading-relaxed text-muted-foreground">
          Tell us what is not working. Your request becomes a ticket for the IT team, and you get
          its ID straight away.
        </p>
        <ul className="flex max-w-sm flex-col gap-2 border-l-2 border-ticket pl-4 text-sm text-muted-foreground">
          <li>
            Card numbers, phone numbers and similar details are masked before the AI agent reads
            your ticket.
          </li>
          <li>Never send a password. IT will not ask for one.</li>
        </ul>
      </header>

      <section
        aria-label="Ticket form"
        className="ticket-stub relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm"
      >
        <div className="flex items-center justify-between gap-4 bg-ticket px-5 py-3 text-ticket-foreground sm:px-7">
          <span className="font-mono text-xs font-semibold tracking-[0.2em] uppercase">
            New ticket
          </span>
          <span className="font-mono text-xs tracking-wider opacity-80">
            No. assigned on submit
          </span>
        </div>
        <div className="ticket-perforation" aria-hidden />
        <div className="px-5 pt-4 pb-6 sm:px-7 sm:pb-8">
          <TicketForm siteKey={siteKey} />
        </div>
      </section>
    </main>
  );
}
