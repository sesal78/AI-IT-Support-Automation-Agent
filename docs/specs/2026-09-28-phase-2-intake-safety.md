# Phase 2 — Intake + safety: task drafts

Source: `docs/PROJECT.md` §6 phase 2 — *On staging: a form submit returns a ticket ID in < 5 s. The raw ticket is stored. The redacted copy replaces a test SSN/email/card with `[REDACTED_*]`. A spam submit without Turnstile is rejected with a 4xx. A ticket with a sensitive topic in the body is flagged.*
Build-loop target repo: `D:/Homebase/Sandbox/ai-it-support-agent` (branch `dev`).

Decisions (2026-09-28): DB access through the Supabase API (supabase-js, schema `itsupport`); the redaction and sensitive-topic check run AFTER intake in a Trigger.dev task; Cloudflare Turnstile on the form; basic form fields, no uploads.

Order (the loop ignores dependencies, so dependent tasks are filed as `blocked` and released in order):
P2-T1 + P2-T2 (start) → P2-T3 → P2-T4 → P2-T5; P2-T6 after P2-T2 + P2-T3.
Human steps (not filed): H6–H9 at the end.

---

## P2-T1 — Migration 0002: redactions and triage tables
Risk: **high-risk** (database migration for the shared stack) · Depends on: nothing

## Description
Add `supabase/migrations/0002_itsupport_intake.sql` and its `.down.sql`. Up: (1) `itsupport.ticket_redactions` (ticket_id uuid PK + FK to tickets, redacted_title text not null, redacted_description text not null, redaction_log jsonb not null default '[]', created_at timestamptz default now()); (2) `itsupport.triage_results` (ticket_id uuid PK + FK, sensitive boolean not null, sensitive_flags jsonb not null, checker text not null, created_at timestamptz default now()) — later phases add columns with new migrations; (3) RLS on both, no policies; grant select/insert/update to `service_role` only; revoke from public/anon/authenticated. Down drops only these 2 tables. Also move the integration test image from `supabase/postgres:15.14.1.177` to `supabase/postgres:17.6.1.177` (the shared stack runs Postgres 17), and re-run migration 0001's tests on it.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] On an empty `supabase/postgres:17.6.1.177` DB with 0001 applied, after 0002 up: both tables exist with the listed columns (integration test reads `information_schema.columns`).
- [ ] Running 0002 up twice exits 0.
- [ ] As `anon` and `authenticated`, select on both tables fails with permission denied; as `service_role`, insert + select succeed.
- [ ] Inserting a redaction for a ticket id that does not exist fails with a foreign-key error.
- [ ] After 0002 down: both tables are gone, and `itsupport.tickets` and its rows still exist.
- [ ] The schema-scope test (from P1-T3) passes for 0002: it only touches schema `itsupport`.
- [ ] All migration 0001 integration tests still pass on the Postgres 17 image.
## Non-Goals
- Applying the migration to the shared Supabase (human step H7). Agents never connect to the shared DB.
- Columns for category/priority/route (phase 3).
## How to Test
- `pnpm test:integration`
## Assumptions
- `supabase/postgres:17.6.1.177` is the newest 17.x Supabase image (checked on Docker Hub 2026-09-27) and matches the shared stack's major version (PG_VERSION = 17).

---

## P2-T2 — Redaction module
Risk: normal · Depends on: nothing

## Description
Add `redact(text: string): { text: string; log: Array<{ type: string; count: number }> }` in `packages/shared`. Replace with `[REDACTED_<TYPE>]`: EMAIL, PHONE (international and AU/US formats), SSN (`ddd-dd-dddd`), CARD (13–19 digits with spaces or dashes, Luhn-valid only), IPV4, SECRET (`password`/`pwd`/`api key`/`token`/`secret` followed by `:` or `=` and a value), AU_TFN (9 digits with Luhn-style TFN check). Pure function, no network.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] `redact("mail jo@x.com or call +61 412 345 678")` returns text `"mail [REDACTED_EMAIL] or call [REDACTED_PHONE]"` and a log with `EMAIL:1, PHONE:1`.
- [ ] `redact("card 4111 1111 1111 1111 ssn 123-45-6789")` redacts both (`[REDACTED_CARD]`, `[REDACTED_SSN]`).
- [ ] A 16-digit number that fails the Luhn check is NOT redacted as CARD.
- [ ] `redact("password: hunter2")` → `"[REDACTED_SECRET]"`; the log never contains the original value.
- [ ] Ticket-style text is left alone: `"INC0012345 on 2026-09-28 at 10:15, version 1.2.3"` is unchanged.
- [ ] Idempotent: `redact(redact(x).text).text === redact(x).text` for every fixture (property test over the fixture list).
- [ ] Empty string → `{ text: "", log: [] }`; a non-string input throws a `TypeError`.
## Non-Goals
- ML/NER-based name detection; storing anything.
## How to Test
- `pnpm --filter shared test`
## Assumptions
- Person names are not redacted in phase 2 (the requester name is stored in the raw ticket only and never sent to AI); noted as a gap for phase 3 evals.

---

## P2-T3 — Database client and repositories
Risk: normal · Depends on: **P2-T1**

## Description
Add a supabase-js client in `packages/db` created from `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` with `db.schema = SUPABASE_DB_SCHEMA` (`itsupport`), server-only. Repository functions: `createTicket(input)` (insert; on duplicate `idempotency_key` return the existing row, `created: false`), `getTicket(id)`, `addEvent(ticketId, type, payload)`, `saveRedaction(...)`, `saveTriage(...)` (upsert by ticket_id). Every function parses its result with zod and throws a typed `DbError` on any Supabase error (no silent defaults). Integration harness: add a `postgrest/postgrest` container next to the Postgres 17 container, exposing schema `itsupport`, so the real supabase-js calls are tested.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] Integration: `createTicket` with a new idempotency key returns `created: true` and a uuid; calling it again with the same key returns the same id and `created: false`.
- [ ] Integration: `addEvent` then a direct select shows the event; an update on `ticket_events` through the client fails (append-only).
- [ ] Integration: `saveTriage` twice for one ticket leaves exactly 1 row with the second values.
- [ ] Unit: a Supabase error response makes each function throw `DbError` with the operation name in the message.
- [ ] Unit: importing the client in a module marked for the browser throws (guard via `server-only` or an explicit check).
## Non-Goals
- The API route and the Trigger.dev task (P2-T4, P2-T6).
## How to Test
- `pnpm --filter db test` · `pnpm test:integration`
## Assumptions
- On the shared stack, `itsupport` is exposed to the REST API by human step H6 before staging tests.

---

## P2-T4 — Intake API with Turnstile, validation and rate limit
Risk: normal · Depends on: **P2-T3**

## Description
`POST /api/tickets` in `apps/web`. A shared zod schema in `packages/shared`: name 1–100, email (valid), department 1–100, title 3–200, description 10–5000, `turnstileToken` required. Steps: validate → verify Turnstile server-side (`https://challenges.cloudflare.com/turnstile/v0/siteverify` with `TURNSTILE_SECRET_KEY` and the client IP) → rate limit 5 submits per IP per 10 minutes (in-memory; single replica) → `createTicket` (idempotency key = header `Idempotency-Key` or a hash of email+title+description+UTC date) → `addEvent('received')` → trigger Trigger.dev task `intake-ticket` with `{ ticketId }` → `201 { ticketId, queued: true }`. If the trigger call fails: event `enqueue_failed`, response `201 { ticketId, queued: false }`. Env additions: `TURNSTILE_SECRET_KEY` (secret), `TURNSTILE_SITE_KEY` (public), update `.env.example`.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] Valid body + Turnstile success (mocked siteverify) → 201 with a uuid `ticketId`, `createTicket` and `addEvent('received')` called once, trigger called with `{ ticketId }`.
- [ ] Missing or failed Turnstile (siteverify `success:false`) → 403 `{ error: "turnstile_failed" }`, nothing stored.
- [ ] Invalid body (e.g. title of 2 chars) → 400 with field errors naming `title`; Turnstile is not called.
- [ ] 6th submit from the same IP within 10 minutes → 429 `{ error: "rate_limited" }`.
- [ ] Same body twice with the same `Idempotency-Key` → second response has the same `ticketId` and the task is not triggered again.
- [ ] Trigger failure (mock throws) → 201 `{ ticketId, queued: false }` and event `enqueue_failed` recorded.
- [ ] The raw description never appears in any log line (spy on the logger/console during the tests).
## Non-Goals
- The form UI (P2-T5); the redaction/check task (P2-T6).
## How to Test
- `pnpm --filter web test`
## Assumptions
- Client IP comes from the `cf-connecting-ip` header (Cloudflare tunnel), falling back to `x-forwarded-for`.
- Unit tests use Cloudflare's published Turnstile test secrets with mocked HTTP; no network in CI.

---

## P2-T5 — Ticket form page
Risk: normal · Depends on: **P2-T4**

## Description
Replace the placeholder home page with a ticket form (react-hook-form + the shared zod schema, shadcn/ui + Tailwind, light and dark mode). Turnstile widget rendered with `TURNSTILE_SITE_KEY` passed from a server component (no build-time `NEXT_PUBLIC_` value, because Dokploy sets env at run time). On success show "Ticket received" with the ticket ID; on 400 show field errors; on 403/429 show a clear retry message. All inputs have labels.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] Playwright: filling all fields and submitting (with `/api/tickets` intercepted to return 201) shows the text "Ticket received" and the returned ticket ID.
- [ ] Playwright: submitting with an empty title shows a field error under Title and sends no request.
- [ ] Playwright: an intercepted 429 shows a message containing "Too many requests".
- [ ] Playwright: the Turnstile container is present, using Cloudflare's always-pass test site key in the test env.
- [ ] Playwright: every input is reachable by its label (`getByLabel`) for Name, Email, Department, Title, Description.
- [ ] Playwright: the page renders in both `prefers-color-scheme: light` and `dark` without console errors.
## Non-Goals
- Admin dashboard; status tracking page.
## How to Test
- `pnpm build && pnpm test:e2e`
## Assumptions
- Visual polish is judged by the proxy checks above; taste review happens at phase sign-off.

---

## P2-T6 — Trigger.dev task: redact and check sensitive topics
Risk: normal · Depends on: **P2-T2, P2-T3**

## Description
Add task `intake-ticket` (schemaTask, input `{ ticketId: uuid }`) in `services/pipeline`. Steps: `getTicket` → `redact` title and description → `saveRedaction` + event `redacted` → sensitive-topic check on the REDACTED text only → `saveTriage({ sensitive, sensitive_flags, checker })` + event `sensitive_checked`. The check has 2 layers: (1) keyword list (legal, lawyer, lawsuit, HR, harassment, termination, fired, dismissal, executive, CEO, CFO, board, breach, ransomware, phishing, data leak) on title + description; (2) TypeSafe (`@typesafe-ai/sdk`, `systemOne`) with one Noul per topic (`legal`, `hr`, `termination`, `executive`, `security_incident`); flagged when a keyword hits OR a Noul ≥ `SENSITIVE_THRESHOLD` (default 0.5). TypeSafe sits behind a small `SensitiveChecker` interface in a new `packages/ai`. Env: `TYPESAFE_API_KEY`, `SENSITIVE_THRESHOLD`, plus the Supabase vars, validated at task start.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent
## Acceptance Criteria
- [ ] Given a ticket with "call 0412 345 678 about my laptop" and a mocked checker returning all Nouls 0.1 → redaction saved with `[REDACTED_PHONE]`, triage saved with `sensitive: false`, events `redacted` then `sensitive_checked`.
- [ ] Given "I am being terminated tomorrow, need my files" → `sensitive: true` with flag `termination` even when the mocked TypeSafe returns 0.0 (keyword layer).
- [ ] Given no keyword hit and a mocked Noul `security_incident: 0.8` → `sensitive: true` with flag `security_incident`.
- [ ] A spy on the checker shows it received only redacted text: no raw email/phone/SSN from the fixture reaches it.
- [ ] Mocked TypeSafe throws → the run throws (so Trigger.dev retries), and no triage row is written.
- [ ] Unknown `ticketId` → the run fails with an error naming the id; nothing is written.
- [ ] Input `{}` is rejected by the schema with an error naming `ticketId`.
## Non-Goals
- Category/priority/routing and KB (phase 3); Slack review (phase 4).
## How to Test
- `pnpm --filter pipeline test`
## Assumptions
- The Noul question wording follows TypeSafe's docs (`type: 'noul'`, `instructions`, answer field `noul` 0–1), checked 2026-09-28. The 0.5 threshold is a starting value; phase 3 evals tune it.

---

## Human steps (not filed)

| # | Step | Who |
|---|---|---|
| H6 | Shared Supabase: add `itsupport` to the REST API's exposed schemas (`PGRST_DB_SCHEMAS` in the Dokploy Supabase compose env), then restart the `rest` service | You (I give the exact line) |
| H7 | Apply migration 0002 in Supabase Studio after P2-T1 merges, then run the check query I give you | You |
| H8 | Create a Cloudflare Turnstile widget for `<staging-host>`; store the secret as `ITSUPPORT_TURNSTILE_SECRET_KEY`; set Dokploy env `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY` | You |
| H9 | Trigger.dev prod env vars for the task: `TYPESAFE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_SCHEMA`; then I deploy the tasks | You (values), Claude (deploy) |

## Filed tasks (ClickUp, Build Loop list 901616104690)

| Task | Status at filing | Tags | Link |
|---|---|---|---|
| P2-T1 — Migration 0002: redactions and triage tables | backlog | high-risk | https://app.clickup.com/t/14zdkkvtfr2 |
| P2-T2 — Redaction module | backlog | — | https://app.clickup.com/t/14zdkkvtfr3 |
| P2-T3 — Database client and repositories | blocked (held for P2-T1) | — | https://app.clickup.com/t/14zdkkvtfr4 |
| P2-T4 — Intake API with Turnstile, validation and rate limit | blocked (held for P2-T3) | — | https://app.clickup.com/t/14zdkkvtfr5 |
| P2-T5 — Ticket form page | blocked (held for P2-T4) | — | https://app.clickup.com/t/14zdkkvtfr6 |
| P2-T6 — Trigger.dev task: redact and check sensitive topics | blocked (held for P2-T2 + P2-T3) | — | https://app.clickup.com/t/14zdkkvtfr7 |
