# AI IT Support Automation Agent

An AI service-desk agent for IT support tickets, rebuilt as a TypeScript monorepo.

**The build spec is [`docs/PROJECT.md`](docs/PROJECT.md).** Read it first: scope, architecture, phases, quality gates and decisions all live there.

The old n8n build is kept for reference only in [`legacy/`](legacy/) (see [`legacy/n8n/README.md`](legacy/n8n/README.md)).

## Layout

| Path                | What                                                 |
| ------------------- | ---------------------------------------------------- |
| `apps/web`          | Next.js (App Router) app: form, admin, API routes    |
| `services/pipeline` | Pipeline package (Trigger.dev tasks in later phases) |
| `packages/shared`   | Shared TypeScript package                            |
| `packages/db`       | Migration checks and DB integration tests            |
| `supabase/`         | SQL migrations (`itsupport` schema)                  |
| `docs/`             | Build spec and task specs                            |
| `legacy/`           | Old n8n build, read-only                             |

## Requirements

- Node.js LTS (version in `.nvmrc`)
- pnpm (version in `package.json` `packageManager`)

## Commands

```bash
pnpm install --frozen-lockfile
pnpm lint           # ESLint via Turborepo
pnpm format:check   # Prettier
pnpm typecheck      # tsc --noEmit per package
pnpm test           # Vitest with coverage (80% floor)
pnpm build          # production build
pnpm test:integration   # migrations vs a throwaway local supabase/postgres container (needs Docker)
pnpm --filter web dev   # dev server on http://localhost:3001
```
