# Phase 1 — Foundation: task drafts

Source: `docs/PROJECT.md` §6 phase 1.
Build-loop target repo: `D:/Homebase/Sandbox/ai-it-support-agent` (a clone of `sesal78/AI-IT-Support-Automation-Agent`, branch `dev`).

Filed tasks (build loop, in dependency order): P1-T1 … P1-T6.
Human steps (not filed, because Vitest or Playwright cannot check them): H1 … H5.

---

## P1-T1 — Move legacy files and scaffold the monorepo
Risk: normal · Depends on: nothing

## Description
Move the old top-level files (`workflows/`, `frontend/`, `docs/node-documentation.md`, `docs/shadow-mode-instructions.md`, `prompt.md`, `implementation plan.md`, `it_support_kb_library.json`, `test-payloads/`, the old `README.md`) into `legacy/` using `git mv`, so history is kept. Keep `docs/PROJECT.md` and `legacy/n8n/` where they are. Scaffold a pnpm workspace + Turborepo with `apps/web` (Next.js App Router, TypeScript, Tailwind, shadcn/ui init), `services/pipeline` (TypeScript package), and `packages/shared` (TypeScript package). Add root scripts `lint`, `format:check`, `typecheck`, `test`, `build`. Configure ESLint, Prettier and Vitest, with an 80% coverage floor. Write a new root `README.md` that points to `docs/PROJECT.md`.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] `pnpm install --frozen-lockfile` exits 0.
- [ ] `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test` and `pnpm build` each exit 0.
- [ ] A Vitest test `repo-layout.test.ts` asserts two things: every root entry is in the allow-list {`apps`, `services`, `packages`, `docs`, `legacy`, `supabase`, `.github`, config files}, and `legacy/` contains `workflows/01-main-it-support-agent.json` and `it_support_kb_library.json`.
- [ ] `git log --follow legacy/prompt.md` shows the original commit `eeec0e2`.
- [ ] Given a test file whose coverage is below 80%, `pnpm test -- --coverage` exits non-zero.
## Non-Goals
- Any feature code, env validation, database or Trigger.dev work.
## How to Test
- `pnpm install --frozen-lockfile && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test -- --coverage && pnpm build`
## Assumptions
- Node LTS and pnpm (the latest stable versions at scaffold time) are pinned in `package.json` `packageManager` and `.nvmrc`.
- `node_modules` lives only in this Sandbox clone, never in the Homebase project folder.

---

## P1-T2 — Env validation and a health endpoint
Risk: normal · Depends on: P1-T1

## Description
Add t3-env (`@t3-oss/env-nextjs`) + zod in `apps/web/src/env.ts`, and a shared zod env helper in `packages/shared` for `services/pipeline`. Phase 1 variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_SCHEMA` (default `itsupport`), `TRIGGER_SECRET_KEY`, `SHADOW_MODE` (`true`/`false`, default `true`), `ADMIN_HEALTH_TOKEN`, `APP_VERSION`. Add `.env.example` with placeholder values only. Add `GET /api/health`, returning `{ status: "ok", version }`.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] Given all variables set, the env module parses, and `GET /api/health` returns 200 with body `{ "status": "ok", "version": "<APP_VERSION>" }` (Vitest route test).
- [ ] Given `SUPABASE_URL` unset, importing the env module throws an error whose message contains `SUPABASE_URL`.
- [ ] Given `SHADOW_MODE=maybe`, parsing throws an error naming `SHADOW_MODE`. Given `SHADOW_MODE` unset, it parses to `true`.
- [ ] A Vitest test asserts that the key set in `.env.example` equals the key set in the env schemas: no missing keys and no extras.
- [ ] A Vitest test asserts `.env.example` contains no value longer than 40 characters and no string starting with `sk-`, `eyJ` or `xoxb-`.
## Non-Goals
- Variables for TypeSafe, LLM, Slack or ServiceNow (added in their own phases).
## How to Test
- `pnpm --filter web test` · `pnpm typecheck`
## Assumptions
- Real values come from the Homebase key store through the approved loader at run time. The agent never reads or writes real values.

---

## P1-T3 — Supabase migration: `itsupport` schema, pgvector, base tables
Risk: **high-risk** (database migration on a shared stack) · Depends on: P1-T1

## Description
Create `supabase/migrations/0001_itsupport_foundation.sql` (up) and `supabase/migrations/0001_itsupport_foundation.down.sql`. Up does 4 things: (1) `create schema if not exists itsupport`; (2) `create extension if not exists vector with schema extensions`; (3) tables `itsupport.tickets` and `itsupport.ticket_events` (append-only, following the §5 data model sketch); (4) RLS enabled on both tables with no policies (deny by default), `service_role` granted usage. Down runs `drop schema itsupport cascade` only. It does NOT drop the `vector` extension, which other apps may use by then. Add an integration test harness that runs against a throwaway `supabase/postgres` container (CI service / local Docker).
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] On an empty `supabase/postgres` DB, after up: `itsupport.tickets` and `itsupport.ticket_events` exist, and `select extversion from pg_extension where extname='vector'` returns 1 row (integration test).
- [ ] Running up twice in a row exits 0 (idempotent).
- [ ] As role `anon`, `select * from itsupport.tickets` returns 0 rows or permission denied, even after a service-role insert. As `service_role`, the insert succeeds.
- [ ] An `update` or `delete` on `itsupport.ticket_events` as `service_role` fails (append-only trigger or revoked privilege).
- [ ] After down: schema `itsupport` does not exist, and extension `vector` still exists.
- [ ] A test asserts that no statement in the migration touches any schema other than `itsupport` and `extensions`, by parsing the SQL for schema-qualified names.
## Non-Goals
- Applying the migration to the shared Dokploy Supabase. That is human step H4.
- Tables for later phases (triage_results, reviews, kb_*, autofix_actions).
## How to Test
- `pnpm test:integration` (starts or uses the `supabase/postgres` container, runs up, down and the assertions)
## Assumptions
- The test image tag is pinned to the same major version as the Dokploy `db` container. The human confirms the exact tag in H4.
- Staging and production share the `itsupport` schema until a later phase decides otherwise (logged as a pending decision).

---

## P1-T4 — Trigger.dev setup and a health-check task
Risk: normal · Depends on: P1-T2

## Description
Add `trigger.config.ts` and a `services/pipeline/src/trigger/healthcheck.ts` `schemaTask` (zod input `{ requestedBy: string }`) that returns `{ ok: true, requestedBy, at }`. Add `POST /api/health/pipeline` in `apps/web`. It requires the header `x-admin-token` equal to `ADMIN_HEALTH_TOKEN` (constant-time compare), triggers `healthcheck`, and returns `202 { runId }`.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] Given `{ requestedBy: "ci" }`, the task's run function returns `ok: true` and an ISO `at` (Vitest, calling the run function directly).
- [ ] Given `{}`, the task's schema rejects the input with an error naming `requestedBy`.
- [ ] `POST /api/health/pipeline` without the header, or with a wrong token, returns 401, and `tasks.trigger` is not called (mocked).
- [ ] With the right token, it returns 202 with `runId` equal to the mocked trigger result.
- [ ] If the mocked `tasks.trigger` throws, the route returns 502 with `{ error: "pipeline_unavailable" }` and does not return 202.
## Non-Goals
- Any ticket pipeline logic. Creating the Trigger.dev project (human step H2).
## How to Test
- `pnpm --filter pipeline test` · `pnpm --filter web test`
## Assumptions
- Trigger.dev SDK v4 (current stable at scaffold time).

---

## P1-T5 — Dockerfile and Playwright smoke test
Risk: normal · Depends on: P1-T2

## Description
Set Next.js `output: "standalone"`. Add `apps/web/Dockerfile` (multi-stage, non-root user, `HEALTHCHECK` on `/api/health`). Add a Playwright smoke test that runs against the production build.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] `docker build -f apps/web/Dockerfile .` exits 0.
- [ ] A container started from the image answers `GET /api/health` with 200 within 20 s (scripted check in `pnpm test:e2e:docker`).
- [ ] `docker run --rm <image> whoami` does not print `root`.
- [ ] Playwright: visiting `/` shows a heading with the text "IT Support", and `/api/health` returns 200.
- [ ] Given the container started without `SUPABASE_URL`, it exits non-zero, and its log names `SUPABASE_URL`.
## Non-Goals
- Creating the Dokploy app (human step H3).
## How to Test
- `pnpm build && pnpm test:e2e` · `pnpm test:e2e:docker`
## Assumptions
- Dokploy builds from this Dockerfile. Its build context is the repo root.

---

## P1-T6 — GitHub Actions CI with all §9 gates
Risk: normal · Depends on: P1-T1 … P1-T5

## Description
Add `.github/workflows/ci.yml`, running on pushes and PRs to `dev` and `main`. It runs: lint, format, typecheck, tests with coverage, build, `pnpm audit --audit-level critical`, gitleaks, integration tests (with a `supabase/postgres` service container), Playwright E2E, and a Docker build. It is approved as part of this spec, which covers the CI change boundary.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] A PR to `dev` shows the check `ci` passing, with separate jobs for each gate.
- [ ] A test branch with a deliberate lint error makes the `lint` job fail (shown in the PR, then reverted).
- [ ] A test branch with a fake secret (`xoxb-` fixture) makes the `gitleaks` job fail (then reverted).
- [ ] The workflow uses only pinned action versions (full commit SHA), checked by a Vitest test that parses `ci.yml`.
## Non-Goals
- Deploy steps and branch protection (human step H5).
## How to Test
- Open a PR to `dev`; watch the `ci` checks.
## Assumptions
- GitHub-hosted runners. No secrets are needed in CI for phase 1 (all external services are mocked).

---

## Human steps (not filed; needed for the phase 1 "done when")

| # | Step | Who |
|---|---|---|
| H1 | Create the `dev` branch from `main`, and clone into `D:/Homebase/Sandbox/ai-it-support-agent` | Claude, on your approval now |
| H2 | Create the Trigger.dev project (`dev` + `staging` + `prod` envs), and add `TRIGGER_SECRET_KEY` to the Homebase key store | You (or Claude through the Trigger.dev MCP, with approval) |
| H3 | Create the Dokploy **staging** app from branch `dev`, using `apps/web/Dockerfile`, with env references from the key store | You (or Claude through Dokploy MCP, with approval) |
| H4 | Confirm the `db` image tag, then apply migration 0001 to the shared Supabase (this enables `vector` and creates `itsupport`) | **You** |
| H5 | Branch protection on `main` and `dev`: require the `ci` check | You |

## Notes
- Your loop config says `/build` and `/review` use the claude.ai ClickUp connector `aba392fb`. That connector is not in this session. These tasks are filed through Composio (account `TopuesAI`) to the same list `901616104690`, and the field IDs match. Check that your loop sessions can see the connector before you start them.
- Sandbox rule: you chose the Sandbox clone for the loop, which knowingly goes past "short test only". This is logged in §11 of PROJECT.md.
