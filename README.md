# AI IT Support Automation Agent

An AI service-desk agent for IT support tickets, rebuilt as a TypeScript monorepo.

**The build spec is [`docs/PROJECT.md`](docs/PROJECT.md).** Read it first: scope, architecture, phases, quality gates and decisions all live there.

The old n8n build is kept for reference only in [`legacy/`](legacy/) (see [`legacy/n8n/README.md`](legacy/n8n/README.md)).

## Layout

| Path                | What                                                       |
| ------------------- | ---------------------------------------------------------- |
| `apps/web`          | Next.js (App Router) app: form, admin, API routes          |
| `services/pipeline` | Trigger.dev tasks (`src/trigger/`) and `trigger.config.ts` |
| `packages/shared`   | Shared TypeScript package                                  |
| `packages/db`       | supabase-js client, repositories, migration checks         |
| `supabase/`         | SQL migrations (`itsupport` schema)                        |
| `docs/`             | Build spec and task specs                                  |
| `legacy/`           | Old n8n build, read-only                                   |

## Requirements

- Node.js LTS (version in `.nvmrc`)
- pnpm (version in `package.json` `packageManager`)

## Docker

`apps/web/Dockerfile` builds the web app as a Next.js standalone server (non-root `node` user, `HEALTHCHECK` on `/api/health`, port 3000). The build context is the repo root; `apps/web/Dockerfile.dockerignore` keeps it to tracked source.

```bash
docker build -f apps/web/Dockerfile -t itsupport-web .
```

The server validates env at boot (`src/instrumentation.ts`) and exits non-zero, naming the variable, if any is missing or invalid.

Playwright needs Chromium once: `pnpm --filter web exec playwright install chromium`.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm lint           # ESLint via Turborepo
pnpm format:check   # Prettier
pnpm typecheck      # tsc --noEmit per package
pnpm test           # Vitest with coverage (80% floor)
pnpm build          # production build
pnpm test:integration   # migrations + repositories vs throwaway local supabase/postgres + PostgREST containers (needs Docker)
pnpm test:e2e           # Playwright smoke test vs the production build on :3002 (run pnpm build first)
pnpm test:e2e:docker    # builds apps/web/Dockerfile and checks the container (needs Docker)
pnpm --filter web dev   # dev server on http://localhost:3001
pnpm deploy:pipeline    # builds packages/*, then trigger deploy (project: TRIGGER_PROJECT_REF, else the main one)
```

## Ticket intake

`POST /api/tickets` takes JSON `{ name, email, department, title, description, turnstileToken }`
(schema: `ticketSubmissionSchema` in `packages/shared`). Order: validate (`400 { error: "invalid_body", fieldErrors }`)
→ Turnstile siteverify with `TURNSTILE_SECRET_KEY` and the client IP (`cf-connecting-ip`, else `x-forwarded-for`;
`403 { error: "turnstile_failed" }`) → 5 submits per IP per 10 minutes, in memory (`429 { error: "rate_limited" }`)
→ store the ticket and a `received` event → trigger the `intake-ticket` Trigger.dev task → `201 { ticketId, queued: true }`.
If the trigger call fails the ticket is kept, an `enqueue_failed` event is recorded and the response is
`201 { ticketId, queued: false }`. An `Idempotency-Key` header (or, without it, a hash of
email + title + description + UTC date) makes a repeat return the same `ticketId` without triggering again.

## Pipeline health check

`POST /api/health/pipeline` with header `x-admin-token: <ADMIN_HEALTH_TOKEN>` triggers the
`healthcheck` Trigger.dev task and returns `202 { runId }` (`401` on a missing or wrong token,
`502 { error: "pipeline_unavailable" }` if Trigger.dev cannot be reached).

`services/pipeline/trigger.config.ts` takes its Trigger.dev cloud project from `TRIGGER_PROJECT_REF`;
unset, it is the main project `proj_sefqgwbhymcyikibqjmo` ("AI IT Support Agent", org Topues).
