# Phase 4 — Slack review: task drafts

Source: `docs/specs/2026-10-04-phases-3-8-plan.md` §6.2 (goal, migration, task table, DoD, test plan `T4.*`, release UAT, goal check), with §1–§5 (§2.5 internal API, §2.6 status model, §4.4 secrets in tests, §5 H14/H15); `docs/PROJECT.md` §5, §7–§9, §11; the format and names of `docs/specs/2026-10-04-phase-3-ai-triage-kb.md`.
Build-loop target repo: `D:/Homebase/Sandbox/ai-it-support-agent` (branch `dev`).
Status: approved by Seun on 2026-10-25 (file all 24 tasks; live tests in October; card design pass before P4-T2b).

Goal (plan §6.2): a ticket routed to `review` posts a redacted card to its environment's Slack channel, and the run pauses (`wait.forToken`). Approve resumes it to `approved`. Reject ends it in the manual queue (`rejected`), with no incident ever. No answer before the timeout escalates it to the manual queue (`escalated_manual`). Every decision is signature-verified, allow-listed and audit-logged.

Decisions used: plan D2 (Seun applies migrations), D6 (24 h timeout; 2 min on e2e), D10 (E2E Trigger.dev project), C3 (separate e2e channel, test signing secret, fake reviewer), C5 (test switches only on e2e test tickets), C6 (checks through the internal API), C7 (allow-list on every decision), C11 (dedicated Slack app). PROJECT §11: 2026-10-08 (lean mode), 2026-10-24 (eval-run rule, TypeSafe use).

## Rules for every task

- Size: one PR, about 200 changed lines, tests included. This is tighter than lean mode's ~450 lines for normal tasks (PROJECT §7), on the orchestrator's instruction for this phase. If a task grows past that, stop and ask for a split.
- Risk (lean mode, PROJECT §11 2026-10-08): `high-risk` only for migration 0005 (P4-T1a, P4-T1b) and the Slack request verification and decision handler (P4-T3a–d). Those need two independent reviews; every other task needs one.
- Tests: happy path, failure path and edge case for every unit of logic (PROJECT §8). Write the tests first and see them fail.
- Privacy: only redacted text leaves the system, and Slack is an external sink. A card, a thread note or an alert line holds only redacted text, enum values, IDs, counts and fixed wording. It never holds raw ticket text, a requester name or email, a secret, or the wait token's `url` or `publicAccessToken` (either one completes the token without a key). Logs and events carry IDs, counts and names only.
- Fail loudly: typed errors, no default text, no swallowed error. A best-effort step (a card update, a notice, an alert post) logs the error class name and raises an alert where this spec says so; it never fails silently.
- New env names go into a shape in `packages/shared/src/env.ts` and into `.env.example`, and `packages/shared/test/env-example.test.ts` must pass. A new required web variable also gets an obvious fake value in `apps/web/vitest.config.ts`, `apps/web/playwright.config.ts` and `apps/web/scripts/docker-smoke.mjs`.
- Slack channel and user IDs are not secrets, but they never appear as code defaults. `.env.example` holds placeholders (`C0000000000`, `U0000000000`); the real values live only in the env (H14).
- Slack formats live in one place, `packages/shared/src/env.ts`: the user ID rule `^[UW][A-Z0-9]{8,12}$`, the channel ID rule `^[CG][A-Z0-9]{8,12}$` and the bot token rule `^xoxb-[A-Za-z0-9-]{10,}$`. The first task that needs a rule adds its helper; later tasks reuse it.
- A new root file or folder goes into the allow-list in `packages/shared/test/repo-layout.test.ts` in the same PR. The new package `packages/slack` is covered by the existing `packages/*` globs.
- New dependency: none in phase 4. The Slack Web API is called with `fetch` (no `@slack/web-api`), and signatures use `node:crypto`. A task that still needs one says so in its report (one line for PROJECT §11).
- Secret-shaped test data is built at run time, or imported from `packages/shared/src/canaries.ts`. Slack tokens and signing secrets in tests are built from pieces, so gitleaks stays green.
- Do not schema-qualify built-in SQL functions. The schema-scope test allows only `itsupport` and `extensions`.
- Agents never connect to the shared database and never apply a migration (H15). They never read or print a key-store value. A test process never holds the real Slack signing secret or the service-role key (plan §2.1, §4.4).
- `.github/workflows/ci.yml` does not change in phase 4.
- A guard module (Slack signature, interaction rules, interactivity handler) is listed in `guard-modules.json` with `statements: 90` and `mutation: 80` by the task that creates it (plan T4.S.05).
- AI budget: TypeSafe is at 86 % of its October cap until 2026-11-01, and the rule of 2026-10-24 allows at most 2 full eval runs per phase per month. Phase 4 makes no full eval run. Local and CI tests never call TypeSafe or the LLM (they are mocked with `msw`). A live scenario creates as few tickets as it can (at most 2), reuses them for its sub-checks, and reports the sum of `aiCallCount` of its tickets in its evidence. The 20-ticket replay T4.L.05 and the waiting-run check T4.F.01 are `heavy`: the default run leaves them out, and they run only with `--only`.
- Real Slack is reached only by the live scenarios, only in `#itsupport-e2e`, and only through the guarded channel helper (P4-T8a) or the e2e pipeline itself.

## Names used across tasks

- Statuses used in phase 4 (plan §2.6): `triaged` → `review_pending` → `approved` | `rejected` | `escalated_manual`; any status → `failed`. A ticket with the route `auto` stays `triaged` (phase 5 moves it on). `approved` has no next step until phase 5.
- Table `itsupport.reviews`: `id`, `ticket_id`, `kind`, `proposal_id`, `slack_user_id`, `decision`, `decided_at`, `wait_token_id`, `slack_ts`, `created_at`. Kinds: `triage` (phase 4), `autofix` (phase 6). Decisions: `approve`, `reject`, `timeout`.
- Task `review-ticket`, ID constant `REVIEW_TICKET_TASK_ID` in `packages/shared`, payload `{ ticketId, testOverrides? }`. Trigger idempotency key `review-ticket:<ticketId>`. Wait-token idempotency key `review:<ticketId>`, tag `ticket:<ticketId>`.
- New ticket events: `review_requested { reviewId }`, `review_decided { reviewId, decision }`, `review_timed_out { reviewId }`, `review_enqueue_failed { error }`, `review_failed { error }` (`error` is an error class name).
- Slack actions: action IDs `review_approve` and `review_reject`; the button value is the review ID (a UUID) and nothing else.
- Interactivity responses: `200 { outcome: "recorded" | "already_decided" | "late" }`, `400 { error: "bad_payload" }`, `401 { error: "unauthorized" }`, `403 { error: "forbidden" }`, `404 { error: "not_found" }`, `413 { error: "too_large" }`, `500 { error: "internal_error" }`, and `405` for any method but POST. Every response has `cache-control: no-store`.
- `security_events`, source `slack`, kinds: `missing_signature`, `bad_signature`, `stale_timestamp`, `body_too_large`, `bad_payload`, `not_allow_listed`, `unknown_review`, `binding_mismatch`, `env_mismatch`. Source `pipeline`, new kinds: `alert:review_enqueue_failed`, `alert:review_failed`, `alert:slack_update_failed`. The sample is `{ path, method }` for `slack` rows and `{ ticketId }` (or `{}`) for alerts.
- Env, web app: `SLACK_SIGNING_SECRET`, `SLACK_REVIEWER_IDS`, `SLACK_CHANNEL_ID`. Env, pipeline: `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_ALERT_CHANNEL_ID` (optional; unset means `SLACK_CHANNEL_ID`), `SLACK_REVIEW_TIMEOUT` (default `24h`; `2m` on the E2E project). Env, live tests only: `E2E_SLACK_SIGNING_SECRET`, `E2E_SLACK_BOT_TOKEN`, `E2E_SLACK_CHANNEL_ID`, `E2E_SLACK_REVIEWER_ID`.
- Test switch (plan C5) added in phase 4: `reviewTimeout`, a whole number of minutes from 1 to 60 written like `30m`.
- Slack facts (H14, done 2026-10-24; IDs only, for the env): bot user `U0CBRU9NS3F`; staging review channel `C0A4RJN780K` (the workspace's #general); e2e channel `C0CBR0YUNBV` (`#itsupport-e2e`); staging reviewer `U0A5ATR4WJD` (Seun); e2e reviewer `UE2EREVIEWER` (fake, test only). The app's one interactivity URL is `https://<staging-host>/api/slack/interactivity`. So a human click on an e2e card reaches staging, which refuses it (`env_mismatch`); e2e decisions are signed by the test helper and sent to `https://<e2e-host>/api/slack/interactivity` through Cloudflare Access.
- `environment`: `e2e` when `E2E_MODE=true`, else `staging`.

## Resolved points (drafted 2026-10-25, for Seun's approval)

The task that uses a point names it.

1. Migration number: `0004` is taken by `0004_itsupport_lock_sequences` (phase 3 security fix). The reviews migration is `supabase/migrations/0005_itsupport_reviews.sql`, its `.down.sql`, and `supabase/checks/0005_itsupport_reviews.check.sql`. Later phases shift by one: phase 5 helpdesk → `0006` (H18), phase 6 auto-fix → `0007` (H20), phase 7 ops → `0008` (H23). Seun applies 0005 (H15); the loop pauses once after P4-T1b merges.
2. `reviews` gets `created_at` beyond the plan's list. `slack_user_id`, `decision`, `decided_at` and `slack_ts` are nullable, because the row is written when the review is requested and decided later. Row checks keep them consistent (P4-T1a).
3. The `reviews` row is the source of truth for a decision. The decision is a compare-and-set update (`where decision is null`) through PostgREST, so no SQL function is needed. The wait token only wakes the run; the run re-reads the row and never trusts the token's output.
4. The review step is its own Trigger.dev task, `review-ticket`, started by `triage-ticket` (PROJECT §5 places it inside `triage-ticket`; the plan calls it a "step"). Reason: a retry of the review never repeats triage's AI calls, and every step before the wait is idempotent.
5. The button value carries only the review ID. The handler takes the ticket, the wait token and the message from the stored row, never from the payload. The payload's `channel.id` must equal `SLACK_CHANNEL_ID`, and its `container.message_ts` must equal the stored `slack_ts`. This is the "payload with a different ticket" check (T4.S.01).
6. The `review-ticket` run owns the bot token and makes every card update and the thread note. The web app needs no bot token: it tells a reviewer "already decided" through the payload's `response_url` (only `https://hooks.slack.com/…` is accepted), best effort. The JSON body of the 200 carries the outcome for tests.
7. Alerts: an alert stays one aggregated `security_events` row plus one error log line (phase 3 resolved point 7). Phase 4 adds an optional Slack post to `SLACK_ALERT_CHANNEL_ID` (default: the review channel) when the Slack env is set. Only the first alert of a (kind, minute) window posts (the returned count is 1), so a flood posts at most one line per kind per minute. A failed post is logged by class name and never throws (P4-T10). This also delivers PROJECT §5 "error alerts to Slack" ahead of phase 7.
8. Slack 429 and 5xx: the client retries inside one call (3 requests; `Retry-After` honoured up to 30 s; else 1 s, then 2 s), then throws `SlackApiError`. The task then retries (3 attempts), and its `onFailure` records `review_failed`, sets `failed` and raises the alert `review_failed`. This is the plan's "loud failure + alert" (T4.I.05).
9. Test switch `reviewTimeout` (e2e test tickets only, 1–60 minutes). T4.F.01 needs a run that waits through a deploy and a rollback, which takes longer than the e2e default of 2 minutes. Unknown switches are still rejected.
10. T4.S.04 (staging never accepts the test secret) uses a dedicated probe that only ever sends a fresh random review ID. The signing helper itself refuses staging hosts (P4-T6, P4-T8c).
11. The live Slack helper trusts `E2E_SLACK_CHANNEL_ID` only after `conversations.info` returns the name `itsupport-e2e` and `is_general: false` (the staging review channel is #general). It never needs the staging channel ID (P4-T8a).
12. KB articles on the card are listed by title and slug. There is no KB web page to link to (plan T4.X.01 says "KB links").
13. Card post retries can duplicate a card: a request that timed out may still have posted, and a post whose `slack_ts` write failed is posted again on retry. A click on an orphan card is refused (`binding_mismatch`). Accepted.
14. Phase 4 adds no dependency and no CI change.
15. Live runs: `pnpm test:live --phase 4` selects the `T4.*` scenarios without the `heavy` ones, so phase 3 scenarios (20+ tickets) are not re-run. `T4.L.05` also measures DoD 1 (20 samples of `review_requested` − `policy_decided`).

## Seun's answers (2026-10-25)

1. TypeSafe budget: run the live verify in October, as soon as the code is ready. The live tasks still keep ticket counts low (rules above).
2. Card copy and layout: design pass first. P4-T2b stays HELD until Seun approves a card mock-up from the orchestrator; the approved copy then replaces the working sentences in P4-T2b.
3. Staging channel: `C0A4RJN780K` is the channel named `#ai-it-support-automation-agent`; it is also the workspace's #general (renamed). So it matches PROJECT §4/§6 and plan §2.1. Alerts default to it.

## Order

The loop builds one task at a time and ignores dependencies. So only tasks with no dependency start in `backlog`. Every other task is filed as `blocked` with a HELD comment and is released when its dependencies are merged to `dev`. The sections below are in build order, which is a valid topological order.

Start in `backlog`: P4-T1a, P4-T3a, P4-T3b, P4-T2a, P4-T8a.

| #   | Task   | Risk      | Depends on                     | Status at filing |
| --- | ------ | --------- | ------------------------------ | ---------------- |
| 1   | P4-T1a | high-risk | —                              | backlog          |
| 2   | P4-T1b | high-risk | P4-T1a                         | blocked (HELD)   |
| 3   | P4-T3a | high-risk | —                              | backlog          |
| 4   | P4-T3b | high-risk | —                              | backlog          |
| 5   | P4-T2a | normal    | —                              | backlog          |
| 6   | P4-T2b | normal    | P4-T2a, card design approval   | blocked (HELD)   |
| 7   | P4-T2c | normal    | P4-T2a                         | blocked (HELD)   |
| 8   | P4-T7a | normal    | P4-T1a                         | blocked (HELD)   |
| 9   | P4-T7b | normal    | P4-T7a                         | blocked (HELD)   |
| 10  | P4-T3c | high-risk | P4-T3a, P4-T3b                 | blocked (HELD)   |
| 11  | P4-T3d | high-risk | P4-T3c, P4-T7a                 | blocked (HELD)   |
| 12  | P4-T10 | normal    | P4-T2c                         | blocked (HELD)   |
| 13  | P4-T4a | normal    | P4-T2b, P4-T2c, P4-T7a, P4-T10 | blocked (HELD)   |
| 14  | P4-T4b | normal    | P4-T4a                         | blocked (HELD)   |
| 15  | P4-T5  | normal    | P4-T4b                         | blocked (HELD)   |
| 16  | P4-T4c | normal    | P4-T5                          | blocked (HELD)   |
| 17  | P4-T8a | normal    | —                              | backlog          |
| 18  | P4-T6  | normal    | P4-T3a, P4-T8a                 | blocked (HELD)   |
| 19  | P4-T9a | normal    | P4-T4c, P4-T1b                 | blocked (HELD)   |
| 20  | P4-T9b | normal    | P4-T3d, P4-T1b                 | blocked (HELD)   |
| 21  | P4-T9c | normal    | P4-T9a, P4-T9b                 | blocked (HELD)   |
| 22  | P4-T8b | normal    | P4-T6, P4-T7b                  | blocked (HELD)   |
| 23  | P4-T8c | normal    | P4-T8b                         | blocked (HELD)   |
| 24  | P4-T8d | normal    | P4-T8b, P4-T4a                 | blocked (HELD)   |

Plan task → parts: P4-T1 → a–b; P4-T2 → a–c; P4-T3 → a–d; P4-T4 → a–c; P4-T5 and P4-T6 are single tasks. Added by this spec: P4-T7a–b (repositories, ticket view, health flag), P4-T8a–d (live suite), P4-T9a–c (integration and local end-to-end suites), P4-T10 (Slack alerts). That is 24 filed tasks.

Dependencies added by this spec, beyond the plan's table: P4-T3d waits for the repositories (P4-T7a); P4-T4a waits for the card, the client, the repositories and the Slack alert sink (P4-T10); P4-T4c (the trigger from `triage-ticket`) waits for the whole review task (P4-T5), so `dev` never starts a half-built review.

After P4-T1b merges, the loop pauses once for H15. Nothing that reads `reviews` is deployed to the e2e app before H15 is done.
Orchestrator steps (O1–O5) and human steps (H14, H15, H25) are at the end. They are not filed.

---

## P4-T1a — Migration 0005, part 1: the `reviews` table

Risk: **high-risk** (database migration for the shared stack) · Depends on: nothing

## Description

Plan §6.2 migration, renumbered 0005 (resolved point 1). Create `supabase/migrations/0005_itsupport_reviews.sql`, `supabase/migrations/0005_itsupport_reviews.down.sql` and the read-only check query `supabase/checks/0005_itsupport_reviews.check.sql`. Up: `itsupport.reviews` with `id uuid` primary key default `gen_random_uuid()`; `ticket_id uuid not null` with a foreign key to `itsupport.tickets (id)` on delete restrict; `kind text not null` (check `triage` or `autofix`); `proposal_id uuid` (nullable); `slack_user_id text` (nullable); `decision text` (nullable; check `approve`, `reject` or `timeout`); `decided_at timestamptz` (nullable); `wait_token_id text not null`; `slack_ts text` (nullable); `created_at timestamptz not null default now()`. Constraint `reviews_ticket_kind_proposal_key`: unique `nulls not distinct (ticket_id, kind, proposal_id)`, so a ticket has at most one triage review. Row checks (resolved point 2): `(decision is null) = (decided_at is null)`; `approve` and `reject` need a `slack_user_id`; `timeout` and an undecided row have none; `triage` rows have no `proposal_id`; `autofix` rows need one. RLS on, no policies. `revoke all on table itsupport.reviews from public, anon, authenticated`; grant `select, insert, update` to `service_role` (no delete). Header comments: shared stack, idempotent, human step H15, apply as one transaction, and the down file is destructive (it drops every review row). Down: drop the table. The check query returns one row per object, `(object text, ok boolean)`: the table, each named constraint, RLS on, and no right for `public`, `anon` or `authenticated`. Add `packages/db/integration/migration-0005.integration.test.ts`, which applies 0001–0004 first.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] On `supabase/postgres:17.6.1.177` with 0001–0004 applied, the up file exits 0, and `information_schema.columns` shows the 10 columns with the listed types and nullability.
- [ ] A triage review for a ticket inserts; a second triage review for the same ticket fails with SQLSTATE `23505` (both `proposal_id` values are null).
- [ ] Two `autofix` reviews for one ticket with different `proposal_id` values insert; the same `proposal_id` twice fails with `23505`.
- [ ] Each of these fails with `23514`: `kind = 'other'`; `decision = 'maybe'`; `decision = 'approve'` with `decided_at` null; `decided_at` set with `decision` null; `decision = 'approve'` with `slack_user_id` null; `decision = 'timeout'` with a `slack_user_id`; a `triage` row with a `proposal_id`; an `autofix` row without one.
- [ ] A `ticket_id` that does not exist fails with `23503`; deleting a ticket that has a review fails with `23503`.
- [ ] The compare-and-set update `set decision = 'approve', decided_at = now(), slack_user_id = '<id>' where id = <id> and decision is null` changes 1 row the first time and 0 rows the second time.
- [ ] As `anon` and `authenticated`, select and insert on `reviews` fail with `42501`. As `service_role`, insert, select and update work, and delete fails with `42501`.
- [ ] Up twice exits 0. Down drops the table and leaves every 0001–0004 object in place; down twice exits 0; up after down works.
- [ ] The check query returns `ok = true` for every row after up, and `ok = false` for the `reviews` rows after down.
- [ ] The schema-scope test (`packages/db/test/migration-schemas.test.ts`) passes for both 0005 files.

## Non-Goals

- Applying the migration to the shared Supabase (H15). Agents never connect to the shared database.
- Repository functions (P4-T7a). The full up → down → up test with seeded rows (P4-T1b).

## How to Test

- `pnpm --filter @ai-it-support/db test` · `pnpm test:integration`

## Assumptions

- The table has no identity column, so the sequence lock of 0004 needs no change, and `service_role` inserts need no sequence right.
- `unique nulls not distinct` exists since Postgres 15; the shared database runs 17.6.
- `slack_user_id` holds a Slack user ID, not a name. It is internal data (PROJECT §5 data model).

---

## P4-T1b — Migration 0005, part 2: up → down → up with seeded rows, and the local stack

Risk: **high-risk** (database migration for the shared stack) · Depends on: **P4-T1a**

## Description

Test task plus one list change. Add `0004_itsupport_lock_sequences.sql` (it is not in the list today) and `0005_itsupport_reviews.sql` to `MIGRATIONS` in `packages/db/integration/rest-stack.ts`, so every REST-stack integration test runs on the schema the shared database will have. Extend `migration-default-privileges.integration.test.ts` so its end state covers `reviews`. In `migration-0005.integration.test.ts`, seed phase-3-shaped rows first: two tickets (`triaged` and `review_pending`), their redactions, triage rows with the route `review`, events up to `triaged`, `ai_calls` rows, `security_events` rows and one decided `reviews` row. Complete the header comments. After this task merges, the loop pauses for H15.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.I.07**: with the seeded rows present, the whole up file, then the whole down file, then the up file again each exit 0. After each step the non-review rows are unchanged (row counts and an `md5` of each table's rows ordered by key).
- [ ] **T4.I.07**: after the second up, a second triage review for a seeded ticket fails with `23505`.
- [ ] After down, the seeded review row is gone and no other table changed (the down file is destructive for `reviews` only).
- [ ] After all migrations, the default-privileges test finds no right for `anon`, `authenticated` or `public` on any `itsupport` object, `reviews` included.
- [ ] Migration 0001's down file still removes the whole schema with 0005 applied.
- [ ] After the full up file the check query returns only `ok = true` rows for 0005.
- [ ] Every existing REST-stack integration test (db, shared, pipeline, web) passes with 0004 and 0005 in `MIGRATIONS`, and `pnpm test:integration` exits 0.

## Non-Goals

- Applying the migration (H15). The `migration0005` health flag (P4-T7b).

## How to Test

- `pnpm test:integration`

## Assumptions

- If an existing integration test needs a sequence right that 0004 removes, the test is wrong, not 0004. The builder stops and reports it; 0004 is never changed here.

---

## P4-T3a — Slack request signature: sign and verify

Risk: **high-risk** (security-critical request verification) · Depends on: nothing

## Description

Add `packages/shared/src/slack-signature.ts` (Slack's v0 signing scheme). `signSlackRequest({ secret, timestamp, body })` returns `v0=` plus the lower-case hex HMAC-SHA256 of `v0:<timestamp>:<body>`. `verifySlackRequest({ secret, headers, body, nowSeconds })` returns `{ ok: true }` or `{ ok: false, reason }` with `reason` one of `missing_signature`, `stale_timestamp`, `bad_signature`, checked in that order. It reads `x-slack-signature` and `x-slack-request-timestamp` (header names case-insensitive). The timestamp must be 1–12 decimal digits and within 300 seconds of `nowSeconds`, either way (300 itself passes). The compare is constant-time: SHA-256 of both sides, then `timingSafeEqual`, as in `apps/web/src/lib/internal/auth.ts`. Pure code: no I/O, no logging. Export both from the package index. Add the module to `guard-modules.json` with `statements: 90` and `mutation: 80`. The live signing helper (P4-T6) uses `signSlackRequest`, so test and production code share one implementation.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.U.01**: a body signed with the secret verifies. Each of these returns `ok: false` with `bad_signature`: a wrong secret, a `v1=` prefix, a digest with one character changed, one changed byte in the body, a trailing newline added to the body.
- [ ] **T4.U.01**: a missing `x-slack-signature` header or a missing timestamp header returns `missing_signature`.
- [ ] **T4.U.02**: with `nowSeconds` fixed, the timestamps now, now − 299, now − 300, now + 299 and now + 300 pass; now − 301 and now + 301 return `stale_timestamp`.
- [ ] A timestamp of `"1e9"`, `" 1700000000"`, `"-5"`, `""` or 13 digits returns `stale_timestamp` and never reaches the HMAC (spy).
- [ ] A known-answer test: Slack's published example from its "Verifying requests from Slack" page (secret, timestamp, body and signature, copied at build time, the secret built from pieces) verifies.
- [ ] `timingSafeEqual` is called once per verify with two buffers of equal length, also when the signature header has another length (spy).
- [ ] `verifySlackRequest` and `signSlackRequest` with an empty secret throw a `TypeError` that names `secret`.
- [ ] With the secret, the signature and the body set to unique markers, no result and no thrown error contains a marker.
- [ ] The module is in `guard-modules.json` with `statements: 90` and `mutation: 80`, and `pnpm test:mutation -- --all` exits 0 with the module at 80 % or more.

## Non-Goals

- The route (P4-T3c). Payload parsing (P4-T3b).

## How to Test

- `pnpm --filter @ai-it-support/shared test` · `pnpm test:mutation -- --all`

## Assumptions

- Slack signs the raw request body as sent. The route must verify the raw text before it parses anything.
- 300 seconds is the window Slack recommends; the plan fixes it (T4.U.02).

---

## P4-T3b — Interaction payload and decision rules

Risk: **high-risk** (security-critical request verification) · Depends on: nothing

## Description

Add `apps/web/src/lib/slack/interaction.ts`, pure code. (1) `parseInteraction(rawBody, contentType)` accepts only `application/x-www-form-urlencoded` with a field `payload` that holds JSON. A zod schema reads `type` (must be `block_actions`), `user.id`, `channel.id`, `container.message_ts`, `response_url` (must start with `https://hooks.slack.com/`) and `actions`, which must have exactly one element with `action_id` `review_approve` or `review_reject` and a UUID `value`. Slack's other fields are allowed and dropped. It returns `{ decision: "approve" | "reject", reviewId, userId, channelId, messageTs, responseUrl }`, or throws `InteractionPayloadError` with a `reason` code (`content_type`, `no_payload`, `not_json`, `wrong_type`, `unknown_action`, `bad_review_id`, `missing_field`, `bad_response_url`) and no input value in the message. (2) `checkReviewer(interaction, reviewerIds)`, with `reviewerIds` the parsed list from the env (P4-T3c): exact match, else `{ allowed: false, status: 403, kind: "not_allow_listed" }`. (3) `checkReviewBinding({ interaction, channelId, e2eMode, review, ticket })`, with `review: { ticketId, slackTs } | null` and `ticket: { isTest } | null`, checked in this order: no review → 404 `unknown_review`; `channelId` differs, or `messageTs` differs from `slackTs`, or `slackTs` is null → 403 `binding_mismatch`; `ticket.isTest !== e2eMode` → 403 `env_mismatch` (plan P4-T3: refuse test tickets on staging and non-test tickets on e2e). Add the module to `guard-modules.json` with `statements: 90` and `mutation: 80`.
Env: none (P4-T3c adds the env shape and the reviewer list).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.U.04**: a valid form-encoded approve payload parses to `decision: "approve"` with the review ID, user, channel, message ts and response URL; the reject payload parses to `reject`.
- [ ] **T4.U.04**: an unknown `action_id`, two actions, zero actions, a missing `value`, a `value` that is not a UUID, and `type: "view_submission"` each throw `InteractionPayloadError` with the matching reason.
- [ ] A JSON content type, a form body without `payload`, a `payload` that is not JSON, and a `response_url` of `https://evil.example/x` or `http://hooks.slack.com/x` each throw with their reason. With a marker in the body, the error message and its `reason` hold no marker.
- [ ] Slack's extra fields (`team`, `message`, `trigger_id`, `state`, `api_app_id`) are accepted and are not in the result.
- [ ] `checkReviewer` allows an allow-listed ID and refuses others with 403 `not_allow_listed`; `U0A5ATR4WJ` and `U0A5ATR4WJDX` are refused when only `U0A5ATR4WJD` is listed.
- [ ] `checkReviewBinding` returns: 404 `unknown_review` for a null review; 403 `binding_mismatch` for another channel, another message ts, or a review with `slackTs` null; 403 `env_mismatch` for a test ticket with `e2eMode: false` and for a non-test ticket with `e2eMode: true`; allowed otherwise.
- [ ] A table test over every combination of (review found, channel match, ts match, `isTest`, `e2eMode`) allows exactly the combinations where all checks hold.
- [ ] The module is in `guard-modules.json` with `statements: 90` and `mutation: 80`, and `pnpm test:mutation -- --all` exits 0 with it at 80 % or more.

## Non-Goals

- Signature verification (P4-T3a). The route and its database calls (P4-T3c, P4-T3d).

## How to Test

- `pnpm --filter web test` · `pnpm test:mutation -- --all`

## Assumptions

- Slack sends `block_actions` as a form field `payload` with JSON (Slack interactivity docs, checked at build).
- The allow-list check runs before any database read (P4-T3c), so a non-allow-listed click costs no query.

---

## P4-T2a — `packages/slack`: package, escaping and message limits

Risk: normal · Depends on: nothing

## Description

Add the workspace package `packages/slack` (`@ai-it-support/slack`), set up like `packages/ai` (build to `dist/`, scripts `build`, `test`, `typecheck`, `lint`). Add `escapeMrkdwn(text)`: `&` → `&amp;`, then `<` → `&lt;`, then `>` → `&gt;`. Add `truncate(text, max)`: unchanged when it fits, else the first `max − 1` code points plus `…`, so an emoji is never split. Add `validateMessage({ text, blocks })`, which returns a list of named limit violations: at most 50 blocks; header text at most 150 characters; section text at most 3 000; at most 10 section fields of at most 2 000 each; button text at most 75; button value at most 2 000; `action_id` at most 255; unique `block_id` values; fallback `text` at most 3 000. Add `assertNoLiveMarkup(message)`: it throws when any `mrkdwn` text object, or the fallback `text`, contains `<`. So no mention, broadcast, channel or link markup can be built from data, and no message the system posts mentions anyone.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.U.03**: `escapeMrkdwn` turns `<!channel>` into `&lt;!channel&gt;`, and does the same for `<!here>`, `<@U123>`, `<#C123>` and `<https://evil.example|click>`; `"a & b"` becomes `"a &amp; b"`; `"&lt;"` becomes `"&amp;lt;"`.
- [ ] **T4.U.03**: `truncate` of a 3 000-character title to 150 gives 150 code points that end with `…`; a 150-character title is unchanged; an empty string stays empty; a string of emoji is cut on a code-point boundary; `max` below 1 throws a `RangeError`.
- [ ] `validateMessage` returns `[]` for a message at every limit exactly, and exactly one named violation for each limit plus one (table test).
- [ ] `assertNoLiveMarkup` passes for escaped text and for a `plain_text` object that holds `<!channel>`. It throws for a `mrkdwn` object or a fallback text with `<!channel>`, `<@U1>` or `<http://x>`, and the error names the `block_id`, not the text.
- [ ] `pnpm --filter @ai-it-support/slack test`, `typecheck`, `lint` and `build` pass, and the root `pnpm test` runs the new package's tests.

## Non-Goals

- The card (P4-T2b). The Web API client (P4-T2c).

## How to Test

- `pnpm --filter @ai-it-support/slack test` · `pnpm test`

## Assumptions

- Slack's limits are taken from the Block Kit reference and checked at build. The 3 000-character cap on the fallback `text` is this spec's choice (Slack allows more but cuts notifications).
- Slack does not parse `plain_text` objects for mentions, links or formatting (Block Kit text-object docs); the live check T4.S.02 confirms it on real Slack.

---

## P4-T2b — Review card builders

Risk: normal · Depends on: **P4-T2a**

## Description

Add to `packages/slack`: `buildReviewCard(input)` → `{ text, blocks, threadSteps }`. The input type has `reviewId`, `ticketId`, `environment` (`e2e` | `staging`), `timeout` (for example `24h`), `redactedTitle`, `redactedDescription`, `category`, `priority`, `urgency`, `assignmentGroup` (each nullable), `reasons` (policy reasons), `flags`, `kbArticles` (`{ title, slug }[]`, at most 3) and `fixSteps` (`{ steps, caveats } | null`). It has no field for a requester, raw text, a token or a URL. Layout approved by Seun on 2026-10-25 (design pass), blocks in this order: (1) header `Review needed: ` + redacted title (truncated to 150); (2) "why" section: `Why: ` + the reasons and flags as plain words joined by ` · ` (map each code to fixed wording, for example `sensitive` + flag `hr` → `sensitive topic (HR)`, `ungrounded_fix` → `fix steps not backed by a KB article`, `low_confidence` → `low triage confidence`, `p1` → `priority P1`, `injection_suspected` → `possible prompt injection`, `needs_info` → `ticket needs more detail`, `outage_or_duplicate` → `possible outage or duplicate`, `cap_reached` → `AI call cap reached`, `llm_unavailable` → `fix-step model unavailable`; an unknown code shows the code itself); (3) section fields Category, Priority, Urgency, Group (`not judged` when null); (4) section `Ticket (redacted)` with the redacted description truncated to 600 characters with `…`; (5) section `Suggested fix steps` with the first 3 steps numbered `1.`–`3.`, plus a line `+N more steps in the thread` when there are more (`none drafted` when null); (6) section `KB articles` as `title (slug)` joined by ` · ` (`none` when empty); (7) actions with the buttons `Approve` (`review_approve`, style `primary`) and `Reject` (`review_reject`, style `danger`), each with the review ID as value; (8) context `Ticket <first 8 chars of ticket ID> · <environment> · decide within <timeout>, then it goes to the manual queue`. `threadSteps` is the thread reply with every step numbered `1.`–`8.` and the caveats, truncated to 3 000, or `null` when there are 3 steps or fewer and no caveats. Every ticket-derived string (title, description, KB title, step, caveat) goes into a `plain_text` object; `mrkdwn` objects hold only fixed wording, code text and `escapeMrkdwn` output. The fallback `text` is `Review needed: ` plus the escaped, truncated title. Add `buildDecidedCard(input, { decision, slackUserId, decidedAt })` (header `Reviewed: ` + title; the why, description, steps, KB and actions blocks are removed; a context line `Approved by <@user id> at <ISO time>` or `Rejected by …`, where the mention is the reviewer's own allow-listed ID built by code, never ticket text; and a context line `Category … · P… · group · ticket <8 chars>`), `buildTimedOutCard(input)` (same shape, line `No decision within <timeout>: sent to the manual queue`) and `buildTimeoutNote({ timeout })` (the thread reply, same sentence). Every result passes `validateMessage` and `assertNoLiveMarkup` (the decided card's own reviewer mention is the one allowed exception and is built from an ID that passed the Slack user ID rule).
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.X.01** (local): a card with every field at its maximum (title 3 000 characters, description 5 000, 8 steps of 500, 5 caveats of 300, 3 KB articles) passes `validateMessage` with no violation and `assertNoLiveMarkup`.
- [ ] The block order is header, why, fields, description, fix steps, KB, actions, context. The actions block has exactly two buttons, `review_approve` and `review_reject`, each with the review ID as its value. The why line for reasons `sensitive` + flag `hr` + `ungrounded_fix` reads `Why: sensitive topic (HR) · fix steps not backed by a KB article`.
- [ ] A description of 1 000 characters shows 600 characters ending in `…`. 5 fix steps show steps 1–3 and `+2 more steps in the thread`, and `threadSteps` holds all 5; 3 steps and no caveats give `threadSteps: null`. The context line holds the first 8 characters of the ticket ID, the environment and `decide within 24h`.
- [ ] **T4.S.02** (local half): a title and description holding `<!channel>`, `<!here>`, `<@U00000000>`, `<https://evil.example|click>` and `*bold*` give a card that passes `assertNoLiveMarkup`. The text appears unchanged in `plain_text` objects, and the fallback `text` holds `&lt;!channel&gt;`.
- [ ] Null category, priority, urgency and group show `not judged`; no KB article shows `none`; `fixSteps: null` shows `none drafted`.
- [ ] Given an input object with extra keys `requesterName`, `requesterEmail` and `rawDescription` that hold markers (passed with a cast), the JSON text of the result holds no marker.
- [ ] `buildDecidedCard` has no actions block, keeps the header and fields, and its context line names the decision, the user ID and the time. `buildTimedOutCard` has no actions block and names the timeout. Both pass the two validators.
- [ ] The same input gives a deep-equal result twice (pure).

## Non-Goals

- Posting the card (P4-T2c, P4-T4a). Visual styling beyond plain Block Kit.

## How to Test

- `pnpm --filter @ai-it-support/slack test`

## Assumptions

- The card shows the redacted description too: PROJECT §4 says the reviewer reads the redacted ticket. It is redacted text, which may leave the system.
- The layout and sentences above were approved by Seun on 2026-10-25 from the orchestrator's mock-up.

---

## P4-T2c — Slack Web API client

Risk: normal · Depends on: **P4-T2a**

## Description

Add `createSlackClient({ token, fetch?, sleep?, timeoutMs? })` to `packages/slack` with `postMessage({ channel, text, blocks, threadTs? })` → `{ ts }` (`chat.postMessage`) and `updateMessage({ channel, ts, text, blocks })` (`chat.update`). Each call is a POST to `https://slack.com/api/<method>` with `Authorization: Bearer <token>`, `Content-Type: application/json; charset=utf-8` and a 10-second timeout per request. Retries inside one call (resolved point 8): HTTP 429 waits `Retry-After` seconds (missing or not 1–3 digits → 1 s; capped at 30 s); HTTP 5xx, a network error or a timeout waits 1 s, then 2 s; at most 3 requests per call. A 200 with `ok: false` throws `SlackApiError` with Slack's error code at once, except `ratelimited`, which is retried like a 429. After the last attempt the error code is `http_<status>` or `network`. A response that is not JSON, or a post reply without `ts`, throws `SlackApiError` `bad_response`. No error, stack field or log line contains the token, the text or the blocks. Add `slackClientEnvShape` to `packages/shared/src/env.ts`: `SLACK_BOT_TOKEN` (the bot token rule), `SLACK_CHANNEL_ID` (the channel ID rule), `SLACK_ALERT_CHANNEL_ID` (optional, same rule).
Env: `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_ALERT_CHANNEL_ID` (new, pipeline; add to `.env.example` with placeholders).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] `postMessage` sends one request with the URL, headers and JSON body above and returns the `ts` of a `200 { ok: true, ts }`. `threadTs` is sent as `thread_ts`. `updateMessage` sends `channel`, `ts`, `text` and `blocks` to `chat.update`.
- [ ] **T4.I.05** (unit half): 429 with `Retry-After: 2`, then 200 → 2 requests and one sleep of 2 000 ms. 500, 502, 200 → 3 requests with sleeps of 1 000 and 2 000 ms. Three 500s → `SlackApiError` `http_500` after 3 requests. 429 with `Retry-After: 999` sleeps 30 000 ms.
- [ ] `200 { ok: false, error: "channel_not_found" }` throws `SlackApiError` `channel_not_found` after 1 request; `{ ok: false, error: "ratelimited" }` is retried.
- [ ] A body that is not JSON, and a post reply without `ts`, throw `SlackApiError` `bad_response`.
- [ ] A request that does not answer within the timeout counts as a network error and is retried (fake timers).
- [ ] With the token and the text set to markers, no error message, no error property and no logger spy call holds a marker.
- [ ] Env: valid values pass. An `xoxp-` token, a channel `#general`, a lower-case channel ID and a channel ID of 4 characters each fail with an error that names the variable. `SLACK_ALERT_CHANNEL_ID` unset is valid. The `.env.example` test passes.

## Non-Goals

- Reading history and deleting messages (test helper, P4-T8a). Alert posts (P4-T10).

## How to Test

- `pnpm --filter @ai-it-support/slack test` · `pnpm --filter @ai-it-support/shared test`

## Assumptions

- Slack Web API docs, checked at build: a rate-limited call returns 429 with `Retry-After`; an app error returns 200 with `ok: false` and an `error` code. The code is a short fixed string, so it may appear in errors and logs.
- A retry after a timeout can post a second card (resolved point 13).

---

## P4-T7a — Reviews repository functions and KB titles

Risk: normal · Depends on: **P4-T1a**

## Description

Add to `packages/db`: `reviewSchema` (zod, one `reviews` row) and these functions, each selecting named columns only. `createTriageReview({ ticketId, waitTokenId })` → `Review`: inserts a `triage` review; on `23505` it returns the existing row unchanged. `getReview(id)` and `getTriageReview(ticketId)` → `Review | null`. `setReviewSlackTs(id, ts)` → `{ changed }`: updates only when `slack_ts` is null. `decideReview(id, decision, slackUserId)` → `{ changed, review }`: a compare-and-set update `where decision is null` that sets `decision`, `decided_at` and `slack_user_id` (resolved point 3); when no row changed it returns the stored row with `changed: false`. A `timeout` must have `slackUserId` null and `approve` / `reject` a valid Slack user ID, else it throws a `TypeError` before any database call. `getKbArticlesByIds(ids)` → `{ id, slug, title }[]` in input order; unknown IDs are left out.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] Integration (local REST stack): `createTriageReview` twice for one ticket returns the same row both times, and the second call's `waitTokenId` is not stored.
- [ ] Integration: `decideReview(id, "approve", "U0000000001")` returns `changed: true` with `decision: "approve"`, `decided_at` set and the user stored. A later `decideReview(id, "reject", …)` returns `changed: false`, and the review still says `approve`.
- [ ] Integration: 10 parallel `decideReview` calls (5 approve, 5 reject) give exactly one `changed: true`, and all 10 return the same stored decision.
- [ ] `decideReview(id, "timeout", "U0000000001")` and `decideReview(id, "approve", null)` throw a `TypeError` with no database call.
- [ ] `setReviewSlackTs` returns `changed: true` the first time; a second call with another ts returns `changed: false` and the stored ts is unchanged.
- [ ] `getReview` returns null for an unknown UUID and throws a `TypeError` for a non-UUID, with no database call.
- [ ] `getKbArticlesByIds([b, a, unknown])` returns `[b, a]`; `getKbArticlesByIds([])` returns `[]` with no database call.
- [ ] A Supabase error in any function throws `DbError` that names the operation.

## Non-Goals

- The ticket view and the health flag (P4-T7b). Callers (P4-T3d, P4-T4a).

## How to Test

- `pnpm --filter @ai-it-support/db test` · `pnpm test:integration`

## Assumptions

- The integration tests run on the stack from P4-T1b if it has merged; otherwise they apply 0005 in their own setup.

---

## P4-T7b — Ticket view `reviews` and the `migration0005` health flag

Risk: normal · Depends on: **P4-T7a**

## Description

Plan §2.5 lists reviews in `GET /api/internal/tickets/:id`. `internalTicketViewSchema.reviews` becomes a strict list of `{ id, kind, decision, decidedBy, decidedAt, slackTs, createdAt }` (`decision`, `decidedBy`, `decidedAt` and `slackTs` nullable), oldest first. `getTicketView` reads the reviews with named columns and never selects `wait_token_id`. `probeSchema` gains `migration0005` (a select on `reviews.id`), `healthConfigSchema.features` gains `migration0005`, and `GET /api/health/config` reports it. Update the live-suite mock (`tests/live/src/testing/mock-e2e.ts`) to the new schema so its tests stay green.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] A ticket with one approved review gives a view with one review entry: `decision: "approve"`, `decidedBy` the user ID, `slackTs` set; the response parses with `internalTicketViewSchema`.
- [ ] A review whose `wait_token_id` is a marker: the marker is not in the response, and the column list sent for `reviews` has no `wait_token_id` (spy on the select call).
- [ ] A ticket without reviews has `reviews: []`; the schema rejects a review entry with an unknown key.
- [ ] `GET /api/health/config` reports `migration0005: true` when every probe passes, and `migration0005: false` with status 200 when only the `reviews` probe fails.
- [ ] The existing ticket-view, health-config and `tests/live` tests pass, and the T3.S.03 test (booleans only) still passes.

## Non-Goals

- Auto-fix rows and notifications (phases 5–6).

## How to Test

- `pnpm --filter web test` · `pnpm --filter @ai-it-support/db test` · `pnpm --filter @ai-it-support/live-tests test`

## Assumptions

- `decidedBy` is a Slack user ID, not a name. The orchestrator needs it to check that the test reviewer decided (T4.L.02), and `slackTs` to find the card and sign test decisions (P4-T6).

---

## P4-T3c — Interactivity handler: verification and refusals

Risk: **high-risk** (security-critical request verification) · Depends on: **P4-T3a, P4-T3b**

## Description

Add `apps/web/src/lib/slack/handler.ts`: `createInteractivityHandler(deps)` returns `(request) => Promise<Response>`. Deps: the env values, `recordSecurityEvent`, a clock, and `decide(interaction)` (P4-T3d). Order: (1) a body over 128 KB → 413 and `body_too_large`, before any HMAC; (2) `verifySlackRequest` on the raw body text with `SLACK_SIGNING_SECRET` → 401 and `missing_signature`, `bad_signature` or `stale_timestamp`; (3) `parseInteraction` → 400 and `bad_payload`; (4) `checkReviewer` with `SLACK_REVIEWER_IDS` → 403 and `not_allow_listed`; (5) `decide(interaction)`, whose response is returned. Each refusal records one security event (source `slack`, sample `{ path, method }` only). If recording fails, the refusal is still returned and the log line has the error class name only. Bodies and headers are the fixed ones in "Names used across tasks". Add `slackInteractivityEnvShape` to `packages/shared/src/env.ts`: `SLACK_SIGNING_SECRET` (at least 32 letters or digits), `SLACK_REVIEWER_IDS` (a comma-separated list without spaces of 1–20 distinct IDs that match the user ID rule, parsed into a list), `SLACK_CHANNEL_ID` (the channel ID rule). Add it to `apps/web/src/env.ts` (required), with fake values in the three web config files. Add the boolean `slackInteractivity` to `/api/health/config`. Add `handler.ts` to `guard-modules.json` with `statements: 90` and `mutation: 80`.
Env: `SLACK_SIGNING_SECRET`, `SLACK_REVIEWER_IDS`, `SLACK_CHANNEL_ID` (new, web app, required; add to `.env.example` with placeholders).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.S.01** (local half): with a fake `decide`, a valid signed approve calls `decide` once with the parsed interaction, and its response is returned unchanged.
- [ ] No signature header → 401 with kind `missing_signature`; a wrong signature → 401 `bad_signature`; a timestamp 301 seconds old → 401 `stale_timestamp`. The three 401s have the same status, body and headers, and `decide` is never called.
- [ ] A signed body with an unknown action → 400 `bad_payload`; a JSON content type → 400 `bad_payload`.
- [ ] A signed approve from `U0000000099`, which is not in `SLACK_REVIEWER_IDS`, → 403 `forbidden` with kind `not_allow_listed`, and `decide` is not called.
- [ ] A body of 128 KB plus 1 byte → 413, and the verifier is not called (spy).
- [ ] A body re-encoded after signing (`%20` changed to `+`) fails with 401: the HMAC runs on the raw text.
- [ ] Each refusal records exactly one security event whose sample has only the keys `path` and `method`. With a failing recorder the refusal is still returned.
- [ ] Env validation fails at boot, naming the variable, for a missing `SLACK_SIGNING_SECRET`, a 31-character secret, an empty `SLACK_REVIEWER_IDS` and a lower-case `SLACK_CHANNEL_ID`. The `.env.example` test passes.
- [ ] `SLACK_REVIEWER_IDS=U0A5ATR4WJD` parses to one ID and `UE2EREVIEWER,U0000000001` to two. `u0a5atr4wjd`, `U1 ,U2`, a duplicate ID and 21 IDs each fail, naming `SLACK_REVIEWER_IDS`.
- [ ] `/api/health/config` has `slackInteractivity: true` with the env set; `healthConfigSchema` stays strict and boolean-only.
- [ ] With the secret, the body and the signature set to markers, no log line and no response holds a marker.
- [ ] `pnpm test:mutation -- --all` exits 0 with `handler.ts` at 80 % or more.

## Non-Goals

- Database reads and the decision (P4-T3d). The route file (P4-T3d).

## How to Test

- `pnpm --filter web test` · `pnpm --filter @ai-it-support/shared test` · `pnpm test:mutation -- --all`

## Assumptions

- 128 KB is well above a real `block_actions` payload with this card (it carries the message, a few KB); the limit stops HMAC work on junk.
- On e2e the test secret is set as `SLACK_SIGNING_SECRET` (H14 mapping), so the same code serves both apps (plan C3).

---

## P4-T3d — Interactivity: recording the decision, and the route

Risk: **high-risk** (decision handler) · Depends on: **P4-T3c, P4-T7a**

## Description

Add `decide(interaction)` and the route `apps/web/src/app/api/slack/interactivity/route.ts` (`dynamic = "force-dynamic"`, POST only). `decide`: `getReview(reviewId)`, then `getTicket(review.ticket_id)`, then `checkReviewBinding` (404 / 403 with its security event). Then `decideReview(id, decision, userId)`. When the row changed → `wait.completeToken(<stored wait_token_id>, { reviewId, decision })` from `@trigger.dev/sdk` → `200 { outcome: "recorded" }`. When the stored decision equals the request's → the completion is sent again (a no-op once done) → `200 { outcome: "already_decided" }`. When the stored decision is the other one → `200 { outcome: "already_decided" }`, no completion. When it is `timeout` → `200 { outcome: "late" }`, no completion. For `already_decided` and `late`, the handler posts `{ response_type: "ephemeral", replace_original: false, text }` with fixed text (`This ticket was already decided.` / `This review timed out; the ticket is in the manual queue.`) to the `response_url`, best effort (a failure is logged by class name). A failed completion → `500 { error: "internal_error" }`; the stored decision stays. A database error → 500. The token ID never comes from the payload and is never in a response or a log line.
Env: none new (`TRIGGER_SECRET_KEY` exists).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] A first approve calls `decideReview(id, "approve", user)`, then `completeToken` once with the stored row's `wait_token_id` and `{ reviewId, decision: "approve" }`, and returns `200 { outcome: "recorded" }`.
- [ ] **T4.I.03**: approve twice → the second returns `already_decided`, `completeToken` is called again with the same token, and one decision is stored. Approve then reject → the second returns `already_decided`, no completion call, the stored decision stays `approve`, and one ephemeral notice is posted to the `response_url`.
- [ ] **T4.I.04** (handler half): a stored `timeout` → `200 { outcome: "late" }`, no completion, one notice.
- [ ] **T4.I.06**: `completeToken` throws → `500 { error: "internal_error" }`, and the review keeps `approve`. The same request again → `completeToken` is called again and the answer is `200 already_decided`; `decideReview` changed a row only once.
- [ ] An unknown review → 404 with `unknown_review`; another message ts → 403 `binding_mismatch`; a test ticket with `E2E_MODE=false` → 403 `env_mismatch`; a non-test ticket with `E2E_MODE=true` → 403 `env_mismatch`. None of these calls `decideReview` or `completeToken`.
- [ ] **T4.S.04** (local half): with the staging config (`E2E_MODE=false`), a validly signed decision for a test ticket is refused with 403 and changes nothing.
- [ ] A `response_url` post that throws still gives 200 with the outcome.
- [ ] With the stored `wait_token_id` set to a marker, no response and no log line holds the marker; log lines carry the review ID, the ticket ID and the outcome only.
- [ ] The route answers POST through `createInteractivityHandler` with the real deps (route test with the deps faked) and 405 for other methods.
- [ ] `pnpm test:mutation -- --all` exits 0 with `handler.ts` at 80 % or more.

## Non-Goals

- Resuming the run and updating the card (P4-T4b). The integration suite (P4-T9b).

## How to Test

- `pnpm --filter web test` · `pnpm test:mutation -- --all`

## Assumptions

- Trigger.dev docs, checked 2026-10-25: a token can be completed from backend code with the secret key, and completing a token that is already completed is a no-op that returns success.
- Slack ignores the body of a 200 for `block_actions`; only tests read the outcome. Slack does not retry a failed interaction; the reviewer can click again, which takes the T4.I.06 path.

---

## P4-T10 — Alerts also post to Slack

Risk: normal · Depends on: **P4-T2c**

## Description

Resolved point 7. `recordSecurityEvent` in `packages/db` returns the new count (the RPC already returns it). `createAlertSink` in `packages/ai` takes an optional `postAlert(line)`. It calls it only when the returned count is 1, and also when recording failed (then the post is the only record). The line is `alert <kind>`, plus ` ticket <id>` when given, plus ` (<environment>)`. Add `createPipelineAlert(env, repos)` in `services/pipeline`: it builds the sink and, when `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` are set, a `postAlert` that posts to `SLACK_ALERT_CHANNEL_ID`, or to `SLACK_CHANNEL_ID` when that is unset. Wire it into `intake-ticket` and `triage-ticket`. The sink never throws; a failed post is logged by class name. Add `slack` (`SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`) to the `healthcheck` task's `configured` map.
Env: none new (uses the names from P4-T2c).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] With the recorder returning 1, `postAlert` is called once with `alert llm_unavailable ticket <id> (e2e)`; with it returning 2, `postAlert` is not called.
- [ ] When recording throws, `postAlert` is still called once, and the log line has the error class name.
- [ ] When `postAlert` throws, the sink resolves and the log line has the error class name only.
- [ ] `createPipelineAlert` without the Slack env posts nothing; with `SLACK_ALERT_CHANNEL_ID` unset it posts to `SLACK_CHANNEL_ID`; with it set, to that channel.
- [ ] The posted line holds only the kind, the ticket ID and the environment (markers passed in other fields never appear).
- [ ] Integration: three `recordSecurityEvent` calls for one (source, kind) in one minute return 1, 2 and 3.
- [ ] The `healthcheck` result has `configured.slack`, true only when both names are set; its keys are the previous six plus `slack`, and the existing healthcheck tests pass with that one change.
- [ ] The phase 3 alert and triage tests pass.

## Non-Goals

- Sentry and the phase 7 forced-failure drill. Alert routing rules beyond one channel.

## How to Test

- `pnpm --filter @ai-it-support/ai test` · `pnpm --filter @ai-it-support/pipeline test` · `pnpm test:integration`

## Assumptions

- The alert channel defaults to the review channel (staging: #general; open question 3).

---

## P4-T4a — `review-ticket` task: post the card and wait

Risk: normal · Depends on: **P4-T2b, P4-T2c, P4-T7a, P4-T10**

## Description

Add the Trigger.dev task `review-ticket` in `services/pipeline/src/trigger/review-ticket.ts` (a `schemaTask`, payload `{ ticketId, testOverrides? }`, `REVIEW_TICKET_TASK_ID` in `packages/shared`). The body `runReviewTicket(payload, deps, attempt)` is exported for tests. Steps: load the ticket. An unknown ID, a status other than `triaged` or `review_pending`, or a triage route other than `review` throws `AbortTaskRunError` that names the ID or the reason; `approved`, `rejected`, `escalated_manual` and `failed` return `{ skipped: true }` with no call. Then: `setTicketStatus("review_pending")`; `wait.createToken({ timeout, idempotencyKey: "review:<ticketId>", tags: ["ticket:<ticketId>"] })`; `createTriageReview`; when the review's `slack_ts` is null, load the redaction, the triage row and the KB titles, `buildReviewCard`, `postMessage` to `SLACK_CHANNEL_ID`, `setReviewSlackTs`; the event `review_requested { reviewId }` unless already written; then `wait.forToken(<the review row's wait_token_id>)`. The timeout is the `reviewTimeout` switch when it applies (`effectiveTestOverrides` with `E2E_MODE` and `is_test`), else `SLACK_REVIEW_TIMEOUT`. `wait` (`createToken`, `forToken`) and the Slack client are deps, so tests replace them. Add `reviewTimeout` to `testOverridesSchema` (`^[1-9][0-9]?m$`, 1–60 minutes). Add `reviewEnvShape`: `SLACK_REVIEW_TIMEOUT`, `^[1-9][0-9]{0,3}[mhd]$`, from 1 minute to 7 days, default `24h`. `createReviewDeps(env)` validates the env at task start and builds the alert sink with `createPipelineAlert` (P4-T10). Until P4-T4b, the body returns after the wait without changing the status; nothing triggers the task until P4-T4c.
Env: `SLACK_REVIEW_TIMEOUT` (new, pipeline, default `24h`; add to `.env.example`).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] Given a `triaged` ticket with route `review` and fakes, the call order is: `getTicket`, `getTriage`, `setTicketStatus("review_pending")`, `createToken`, `createTriageReview`, `getRedaction`, `getKbArticlesByIds`, `postMessage`, `setReviewSlackTs`, event `review_requested`, `forToken`.
- [ ] `createToken` gets the timeout `24h` with the env unset, the key `review:<ticketId>` and the tag `ticket:<ticketId>`. With `E2E_MODE=true`, `is_test = true` and `reviewTimeout: "30m"` it gets `30m`; with `is_test = false` it gets the env value.
- [ ] When `createTriageReview` returns an existing row with the token `t-old`, `forToken` gets `t-old`.
- [ ] A retry where the review already has a `slack_ts` and `review_requested` is written makes no `postMessage` call and writes no event, and still calls `forToken`.
- [ ] Given raw title, raw description, requester name and email set to markers, no `postMessage` argument, event payload or log line holds a marker; the card holds the redacted title.
- [ ] The `url` and `publicAccessToken` that `createToken` returns (markers) are in no `postMessage` argument, event payload, repository call or log line.
- [ ] Route `auto`, an unknown ID and the status `new` each throw `AbortTaskRunError`; the status `approved` returns `{ skipped: true }` with no further call.
- [ ] `postMessage` throwing `SlackApiError` makes the attempt throw: no `review_requested` event, and the status stays `review_pending`.
- [ ] The payload `{}` is rejected, naming `ticketId`. `reviewTimeout` values `"2h"`, `"0m"` and `"61m"` are rejected by the schema.
- [ ] `createReviewDeps` without `SLACK_BOT_TOKEN` throws, naming it. `SLACK_REVIEW_TIMEOUT` values `24`, `0h` and `8d` fail, naming it.

## Non-Goals

- What happens after the wait (P4-T4b, P4-T5). The trigger from `triage-ticket` (P4-T4c).

## How to Test

- `pnpm --filter @ai-it-support/pipeline test` · `pnpm --filter @ai-it-support/shared test`

## Assumptions

- Trigger.dev docs, checked 2026-10-25: inside a task a string idempotency key is scoped to the run, so a retried attempt gets the same token back (`isCached: true`), and waiting on a token that is already completed or timed out returns at once. Time spent waiting is checkpointed and is not compute time.

---

## P4-T4b — `review-ticket`: resume on Approve or Reject

Risk: normal · Depends on: **P4-T4a**

## Description

After `forToken` returns, re-read the review row; the row decides, the token output is ignored (resolved point 3). `approve` → event `review_decided { reviewId, decision: "approve" }` (unless written), status `approved`, then `updateMessage` on the stored `slack_ts` in `SLACK_CHANNEL_ID` with `buildDecidedCard`. `reject` → the same with `rejected`. A failed card update raises the alert `slack_update_failed` (a new `AlertKind`) once, logs the class name and still ends the run with the decision (a later click gets "already decided"). A token that completed while the row is still undecided throws `AbortTaskRunError` ("token completed without a stored decision"), and nothing is written. An undecided row with a timed-out token throws a typed `ReviewTimeoutUnhandledError` until P4-T5 handles it. Nothing is triggered after a decision in phase 4. The result is `{ ticketId, skipped: false, decision }`.
Env: none new.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] Token completed and row `approve`: the event `review_decided { reviewId, decision: "approve" }`, then the status `approved`, then `updateMessage` with the env channel, the stored ts and the decided card; the result has `decision: "approve"`.
- [ ] Row `reject` → status `rejected`; **T4.I.02** (unit half): the deps' trigger spy is never called.
- [ ] The token output says `reject` but the row says `approve` → `approved`.
- [ ] When the status write fails, the attempt throws. The retry writes no second `review_decided`, sets the status, and updates the card.
- [ ] `updateMessage` throwing → the run returns `approved`, the alert `slack_update_failed` is raised once, and the log line has the class name.
- [ ] Token completed and row undecided → `AbortTaskRunError`, no event, no status write.
- [ ] No event payload or log line holds ticket text or the token ID.

## Non-Goals

- The timeout path and the failure handler (P4-T5). The helpdesk step after `approved` (phase 5).

## How to Test

- `pnpm --filter @ai-it-support/pipeline test`

## Assumptions

- A stale card is cosmetic: the decision is stored, and the handler refuses a second decision.

---

## P4-T5 — Review timeout and the failure handler

Risk: normal · Depends on: **P4-T4b**

## Description

Plan P4-T5. A timed-out token with an undecided row → `decideReview(id, "timeout", null)`. When the row did not change (a decision was stored at the last moment), the stored decision takes the P4-T4b path. When it changed: post the thread note (`postMessage` with `threadTs` = the stored ts and `buildTimeoutNote`), then the event `review_timed_out { reviewId }`, then the status `escalated_manual`, then the card update with `buildTimedOutCard` (best effort, as in P4-T4b). The note comes before the status, so a failed note is retried by the next attempt. No incident and no helpdesk step. Add `onReviewFailure({ payload, error })` and wire it as the task's `onFailure`: the event `review_failed { error: <class name> }`, the status `failed` unless the ticket is already `approved`, `rejected`, `escalated_manual` or `failed`, and the alert `review_failed` (a new `AlertKind`). It never throws.
Env: none new.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.I.04** (unit half): token timed out and row undecided → `decideReview(timeout)`, a thread note with `thread_ts` = the stored ts, the event `review_timed_out`, the status `escalated_manual` and a card update, in that order; no trigger call.
- [ ] Token timed out, `decideReview` returns `changed: false` with a stored `approve` → the ticket ends `approved` and no note is posted.
- [ ] The note post throws → the attempt throws before the status write. The retry (token cached and timed out) posts the note and finishes, and `review_timed_out` is written once.
- [ ] The note text names the timeout value and holds no ticket text.
- [ ] `onReviewFailure` on a `review_pending` ticket records `review_failed { error }`, sets `failed` and raises one alert. On an `approved` ticket it changes nothing. With the database down it logs the class name and does not throw.
- [ ] **T4.I.05** (unit half): `postMessage` throws on every attempt; after three attempts (simulated) `onReviewFailure` sets `failed` and raises `review_failed`.
- [ ] The task options pass `onReviewFailure` as `onFailure` (asserted on the exported options).

## Non-Goals

- A manual-queue view (phase 7 dashboard).

## How to Test

- `pnpm --filter @ai-it-support/pipeline test`

## Assumptions

- Trigger.dev docs (checked for phase 3): `onFailure` runs once after all retries; it does not run for crashed or cancelled runs.

---

## P4-T4c — `triage-ticket` starts the review

Risk: normal · Depends on: **P4-T5**

## Description

Extend `runTriageTicket`. After `setTicketStatus("triaged")`, when the route is `review`, it calls `deps.triggerReview({ ticketId, testOverrides }, { idempotencyKey: "review-ticket:<ticketId>" })`, with the payload's `testOverrides` unchanged. If the trigger fails: event `review_enqueue_failed { error }`, status `failed`, alert `review_enqueue_failed` (a new `AlertKind`), and the run throws `AbortTaskRunError` that names the ticket ID. Crash recovery: a run that finds the ticket already `triaged` with a saved route `review` triggers again with the same key (the trigger is idempotent) and then returns `{ skipped: true }`. Route `auto` triggers nothing and stays `triaged`. A ticket at `review_pending` or later is skipped with no trigger.
Env: none new.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] A review ticket: `triggerReview` is called once after the status write, with `{ ticketId }`, the payload's `testOverrides` unchanged and the key `review-ticket:<ticketId>`.
- [ ] An auto ticket: no `triggerReview` call; the status stays `triaged`.
- [ ] `triggerReview` throws → the event `review_enqueue_failed { error: <class name> }`, the status `failed`, one alert, and `AbortTaskRunError` with the ticket ID.
- [ ] A ticket already `triaged` with the saved route `review` → `triggerReview` is called with the same key, no AI call and no event, and the result is `{ skipped: true }`.
- [ ] A ticket already `review_pending` → no trigger and `{ skipped: true }`.
- [ ] The existing triage tests pass.

## Non-Goals

- The trigger after `approved` (phase 5).

## How to Test

- `pnpm --filter @ai-it-support/pipeline test`

## Assumptions

- Trigger.dev docs (checked for phase 3): an `idempotencyKey` on a trigger call returns the first run instead of starting a second one.

---

## P4-T8a — Live Slack channel helper and runner selection

Risk: normal · Depends on: nothing

## Description

Test code only, in `tests/live`. Add `createE2eSlackChannel(config, fetch)` in `tests/live/src/slack-channel.ts`. Before any other call it runs `auth.test` (to learn the bot user ID) and `conversations.info` on `E2E_SLACK_CHANNEL_ID`; unless the name is `itsupport-e2e` and `is_general` is false, every method throws `SlackChannelGuardError` (resolved point 11). Every method takes a channel ID and refuses any ID other than the verified one: `history({ oldest })` (`conversations.history`, cursor paging), `replies(ts)`, `post(text)` and `delete(ts)` (only messages posted by the bot user). Add `liveSlackEnvShape`: `E2E_SLACK_BOT_TOKEN` (the bot token rule), `E2E_SLACK_CHANNEL_ID` (the channel ID rule), `E2E_SLACK_SIGNING_SECRET` (at least 32 letters or digits), `E2E_SLACK_REVIEWER_ID` (the user ID rule). `loadLiveConfig` reads them as optional; a scenario that needs a missing one reports `not_run`. Add a mock Slack Web API in `tests/live/src/testing/mock-slack.ts`. Runner: a scenario may be `heavy`; the default run and `--phase <n>` (scenarios whose ID starts with `T<n>.`) leave heavy scenarios out, and `--only` can select them. Add the scenario `T4.S.06`.
Env: `E2E_SLACK_BOT_TOKEN`, `E2E_SLACK_CHANNEL_ID`, `E2E_SLACK_SIGNING_SECRET`, `E2E_SLACK_REVIEWER_ID` (new, live tests only; add to `.env.example`).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.S.06**: asked to read, post or delete in `C0000000001` (not the verified channel), the helper throws `SlackChannelGuardError`, and the mock records no request for that channel. The scenario passes against the mock.
- [ ] `conversations.info` returning the name `general`, `is_general: true`, or the name `ai-it-support-automation-agent` → every method throws the guard error, and no other Slack method is called.
- [ ] `history` follows the cursor across two pages and returns each message's `ts`, `user`, `text`, `blocks` and `thread_ts`; `replies` returns the thread.
- [ ] `delete` of a message whose `user` is not the bot user is refused before any request.
- [ ] The token goes only in the `Authorization` header to the Slack origin; with it set to a marker, the marker is in no output, no report and no error.
- [ ] `liveSlackEnvShape`: a bad token, channel or user ID fails, naming the variable. With the names unset, a scenario that needs them is reported `not_run` (runner exit code 2).
- [ ] `--phase 4` selects only `T4.*` scenarios that are not heavy; `--only T4.L.05` selects a heavy one; the default run selects no heavy scenario.

## Non-Goals

- The review scenarios (P4-T8b–d). Posting cards (only the pipeline posts them).

## How to Test

- `pnpm --filter @ai-it-support/live-tests test`

## Assumptions

- The bot has `channels:history` and `channels:read` (H14), which `conversations.history`, `conversations.replies` and `conversations.info` need. Plan §2.1 item 6 allows the agent to post and delete its own bot messages in `#itsupport-e2e`.
- `E2E_SLACK_BOT_TOKEN` holds the one app's bot token (plan §4.4), mapped from `ITSUPPORT_SLACK_BOT_TOKEN` by the approved loader.

---

## P4-T6 — Signed-request test helper

Risk: normal · Depends on: **P4-T3a, P4-T8a**

## Description

Plan P4-T6. Add `tests/live/src/slack-signer.ts`: `createSlackSigner(config)` uses `E2E_SLACK_SIGNING_SECRET`, `E2E_SLACK_REVIEWER_ID` and `E2E_SLACK_CHANNEL_ID`. `signedDecision({ reviewId, slackTs, decision, userId?, timestampOffsetSeconds?, secretOverride?, tamper? })` builds a `block_actions` payload (one action, `review_approve` or `review_reject`, the review ID as value, `channel.id`, `container.message_ts`, `user.id`, `response_url` `https://hooks.slack.com/actions/T0000000000/0/test`), form-encodes it and signs it with `signSlackRequest`. `send(signed)` POSTs it to `<E2E_BASE_URL>/api/slack/interactivity` through the internal client (Cloudflare Access headers) and returns the status and the parsed outcome. It refuses a target host that equals the host of `STAGING_BASE_URL` or whose first label contains `staging`, before any request. `loadLiveConfig` refuses to load when `SLACK_SIGNING_SECRET` is set in the test process (the real secret must never be there; plan §2.1). Add an interactivity endpoint to the e2e mock that verifies with the shared verifier and the test secret.
Env: none new (uses the names from P4-T8a).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] A signed approve verifies with `verifySlackRequest` and the test secret, and the mock e2e app answers it with 200.
- [ ] The payload has `type: "block_actions"`, one action with the decision's action ID and the review ID as value, the user, the channel and `container.message_ts`.
- [ ] `secretOverride` with a random secret → the mock answers 401; `timestampOffsetSeconds: -301` → 401; `tamper: true` (one body byte changed after signing) → 401.
- [ ] A base URL whose host is the staging host, or whose first label contains `staging`, is refused before any request (the mock records 0 requests).
- [ ] With `SLACK_SIGNING_SECRET` set in the env, `loadLiveConfig` throws an error that names `SLACK_SIGNING_SECRET` and holds no value.
- [ ] With the test secret set to a marker, no stdout, stderr or report holds the marker.

## Non-Goals

- Signing for staging. Any decision as Seun (plan C3).

## How to Test

- `pnpm --filter @ai-it-support/live-tests test`

## Assumptions

- The e2e app's `SLACK_SIGNING_SECRET` and the tests' `E2E_SLACK_SIGNING_SECRET` hold the same e2e test secret, from `ITSUPPORT_E2E_SLACK_SIGNING_SECRET` (H14).

---

## P4-T9a — Pipeline integration suite: the review flow

Risk: normal · Depends on: **P4-T4c, P4-T1b**

## Description

Test-only task. Add `services/pipeline/integration/review.integration.test.ts`. It runs the real `runIntakeTicket`, `runTriageTicket` and `runReviewTicket` bodies with real repositories against the local REST stack (0001–0005). TypeSafe, the LLM and Langfuse are mocked at HTTP with `msw` (the sensitive answer), and Slack is mocked at `https://slack.com/api/*`. A test-support token broker `createTokenBroker()` (`createToken`, `forToken`, `complete`, `timeOut`) is the `wait` dep. A decision is made as the handler makes it: `repos.decideReview`, then `broker.complete`. The egress recorder (P3-T12a) is on, and Slack counts as an egress host. Each ticket's description is an HR complaint plus `canaryTicketText(run)`, and its requester name and email are registered with `recorder.forbid`.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.I.01**: approve → status `approved`; one `reviews` row with `approve` and the user ID; the events after `triaged` are `review_requested` then `review_decided`; the Slack mock received 1 `chat.postMessage` and 1 `chat.update`.
- [ ] **T4.I.02**: reject → `rejected`, and the trigger recorder sees no task trigger after `review-ticket` started.
- [ ] **T4.I.04**: the broker times the token out → `escalated_manual`, decision `timeout`, a thread reply with `thread_ts` = the card ts, and a card update. A later `decideReview(approve)` returns `changed: false`, and the status stays `escalated_manual`.
- [ ] **T4.I.05**: Slack answers 429 (`Retry-After: 1`) and then 200 → the card is posted after 2 requests. Slack always answers 500 → 3 attempts of 3 requests each (fake sleep), then `onReviewFailure`: status `failed`, event `review_failed`, and one `security_events` row (`pipeline`, `alert:review_failed`) with `count = 1`.
- [ ] Running `review-ticket` twice for one ticket leaves one `reviews` row, one card post and one `review_requested` event.
- [ ] DoD 2 (local): the egress recorder is clean for every test: 0 canaries, 0 registered names or emails, and no wait-token URL (a marker from the broker) in any Slack request.
- [ ] `pnpm test:integration` exits 0.

## Non-Goals

- The web route (P4-T9b). The Trigger.dev runtime itself.

## How to Test

- `pnpm test:integration`

## Assumptions

- The broker models what the docs state: a completed or timed-out token returns at once to `forToken`, and an idempotent create returns the same token.

---

## P4-T9b — Web integration suite: the interactivity endpoint

Risk: normal · Depends on: **P4-T3d, P4-T1b**

## Description

Test-only task. Add `apps/web/integration/slack-interactivity.integration.test.ts`. It calls the real route against the local REST stack (0001–0005) with the egress recorder on. The Trigger.dev API (token completion) and `hooks.slack.com` are mocked with `msw`. Seed a `review_pending` ticket with a `reviews` row that has a `slack_ts` and a `wait_token_id`. Requests are signed with `signSlackRequest` and the fake test secret.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] A signed approve → `200 recorded`; the row says `approve`; the Trigger.dev mock received one completion for the stored token ID.
- [ ] **T4.I.03**: approve twice → one stored decision and `already_decided`; approve then reject → the row stays `approve`, and `hooks.slack.com` received one ephemeral notice.
- [ ] **T4.I.06**: the Trigger.dev mock answers 500 → `500 internal_error`, the row says `approve`. The same request with the mock answering 200 → `200 already_decided`, one completion request, and `decided_at` unchanged.
- [ ] **T4.S.01** (local half): no signature, a bad signature, a stale timestamp, a non-allow-listed user and another message ts give 401, 401, 401, 403 and 403. `security_events` has one `slack` row per kind; 30 bad-signature requests in a burst leave at most 2 rows whose counts add up to 30.
- [ ] **T4.S.03** (local half): 200 random bodies (seeded) with random content types and headers never get a 5xx, and the review row is unchanged afterwards.
- [ ] **T4.S.04** (local half): with `E2E_MODE=false` and a test ticket, a validly signed decision → 403 `env_mismatch`, and the row is unchanged.
- [ ] The egress recorder is clean: the notice to `hooks.slack.com` carries only the fixed text. `pnpm test:integration` exits 0.

## Non-Goals

- Live checks on the e2e app (P4-T8c).

## How to Test

- `pnpm test:integration`

## Assumptions

- The SDK sends the completion to the Trigger.dev API URL from `TRIGGER_API_URL`, which the test points at the mock (as P3-T10g does for triggers).

---

## P4-T9c — Local runner: review tasks, and the local end-to-end test

Risk: normal · Depends on: **P4-T9a, P4-T9b**

## Description

Extend `services/pipeline/test-support/local-runner.ts`: it runs `review-ticket`, uses an in-process token broker as the `wait` dep, and answers the Trigger.dev waitpoint completion request (shape taken from SDK 4.6.4 at build time) by completing the broker's token. The runner's `msw` answers Slack. Add `apps/web/e2e/review.spec.ts` (Playwright) for **T4.E.01**. The locally built web app runs with `E2E_MODE=true`, the fake test signing secret and the fake reviewer ID. The diff touches only test-support files, `apps/web/e2e/**` and the Playwright config.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T4.E.01**: a test ticket with the mocked sensitive answer reaches `review_pending` with a `slackTs` in the ticket view. A signed approve POSTed to the local build answers `200 recorded`, and within 10 seconds the view shows `approved`.
- [ ] **T4.E.01**: a second ticket, signed reject → `rejected`.
- [ ] A request with a bad signature gets 401, and the status is unchanged.
- [ ] The runner answers a completion for an unknown token with 404; a broker token that timed out gives `forToken` `ok: false`.
- [ ] The spec passes with the network switched off, the existing specs pass, and `pnpm build && pnpm test:e2e` exits 0.

## Non-Goals

- A full Trigger.dev emulator (queues, schedules). Live tests (P4-T8b).

## How to Test

- `pnpm build && pnpm test:e2e`

## Assumptions

- The CI `e2e` job has Docker, which the local REST stack needs (as in phase 3).

---

## P4-T8b — Live scenarios: the review flow

Risk: normal · Depends on: **P4-T6, P4-T7b**

## Description

Add four scenarios, each tested against the mock e2e app and the mock Slack API. A shared step `createReviewTicket(context, scenarioId)` creates one synthetic HR complaint from `demo.erin` through `POST /api/internal/test-tickets` (`testId` = `<runId>:<scenarioId>:<n>`) and waits (60-second limit) until the view shows `review_pending` and a review with a `slackTs`. `T4.L.01`: the description is the HR complaint plus `canaryTicketText(runId)`; the card is found in `#itsupport-e2e` history by its ts; it has two buttons with the two action IDs and the review ID; `findCanaries` over the whole message JSON finds 0; the header equals the view's redacted title (truncated); judge J4 (P3-T11d endpoints) scores the card's text at 0.7 or more (T4.X.01 live, one TypeSafe call). `T4.L.02`: a signed approve as `E2E_SLACK_REVIEWER_ID` → `200 recorded`; the view shows `approved` within 5 seconds of the response (polling every 500 ms); `decidedBy` is the test reviewer; the card in history has no actions block and names the decision. `T4.L.03`: a signed reject → `rejected`; the card is updated; no further event within 30 seconds of `review_decided`. `T4.L.04`: no decision → `escalated_manual` within 4 minutes; a thread reply under the card holds the note; the review's decision is `timeout`; the card has no actions block.
Env: none new.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] `T4.L.01` passes against the mock. It fails when the card is missing from history, when a canary is in the message, when a button is missing, and when the judge score is 0.69.
- [ ] `T4.L.02` passes when the mock approves within 1 second. It fails when `approved` comes after 6 seconds (fake clock), when `decidedBy` is another user, and when the card still has buttons.
- [ ] `T4.L.03` passes for `rejected` with an updated card, and fails when another event follows `review_decided`.
- [ ] `T4.L.04` passes when the mock escalates and posts the thread reply. It fails when the thread reply is missing, and when the status is still `review_pending` at the limit (shortened in the test).
- [ ] Each scenario creates exactly one ticket; across the four, the mock sees 4 `test-tickets` requests, 0 form submits and 1 judge call.
- [ ] Each scenario's evidence has ticket IDs, review IDs, the card ts, times in ms and the sum of `aiCallCount`; no ticket text.

## Non-Goals

- Security scenarios (P4-T8c). The replay and the waiting-run check (P4-T8d).

## How to Test

- `pnpm --filter @ai-it-support/live-tests test`

## Assumptions

- On e2e, `SLACK_REVIEW_TIMEOUT` is `2m` (H14); 4 minutes leaves room for the queue and the poll.

---

## P4-T8c — Live scenarios: security

Risk: normal · Depends on: **P4-T8b**

## Description

Add four scenarios, each tested against the mocks. `T4.S.01` uses two review tickets: A is left waiting, B is approved first. On A: a request signed with a random secret → 401; a timestamp 301 seconds old → 401; a non-allow-listed user (`U0000000099`) → 403; A's review ID with B's message ts → 403; afterwards A is still `review_pending` with no decision. On B: the exact approve request sent again (same body and timestamp, within 300 s) → `200 already_decided`; B's decision is unchanged and B has one `review_decided`. `security-events` since the scenario start include `bad_signature`, `stale_timestamp`, `not_allow_listed` and `binding_mismatch`. Then A is approved, so it does not wait for the timeout. `T4.S.02`: a ticket whose text holds `<!channel> <!here> <@U00000000> <https://evil.example|click> *bold*`; in the card read back from history no `mrkdwn` text holds `<`, the fallback `text` holds `&lt;!channel&gt;`, and the `plain_text` holds the characters unchanged. `T4.S.03`: 200 random bodies (seeded by the run ID) with random content types and with missing, random or stale signature headers, 10 at a time; no answer is 5xx, every status is 400, 401, 403, 404 or 413; afterwards every review this run created is unchanged and `/api/health` answers 200. `T4.S.04`: a payload with a fresh random review UUID, signed with the test secret, POSTed with plain fetch (no Access headers, no internal token) to `<STAGING_BASE_URL>/api/slack/interactivity` → 401 (resolved point 10); reported `not_run` without `STAGING_BASE_URL`.
Env: none new.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] `T4.S.01` passes against the mock. It fails, naming the check, when the mock accepts the forged request, when the replay changes B, and when a security event kind is missing.
- [ ] `T4.S.02` passes when the mock card is plain text, and fails when a `mrkdwn` field holds `<!channel>`.
- [ ] `T4.S.03` passes against the mock, fails when one request gets 500, and never runs more than 10 requests at a time (the mock records the peak).
- [ ] `T4.S.04` passes when the staging mock answers 401, fails when it answers 200, 403 or 404, and is `not_run` (exit code 2) without `STAGING_BASE_URL`. The staging mock receives no Access header and no bearer token.
- [ ] `T4.S.04` only ever sends a review ID that the run generated at random (asserted on the request the mock records).
- [ ] The scenarios create 3 tickets in total (A, B and the S.02 ticket); the evidence has status codes, counts and IDs only.

## Non-Goals

- Fixing the app when a scenario fails on e2e (that becomes a fix task, plan §2.2 step 7).

## How to Test

- `pnpm --filter @ai-it-support/live-tests test`

## Assumptions

- A 401 from staging proves it does not accept the test secret; the random review ID means even a broken staging could not change a real review.

---

## P4-T8d — Live: sensitive replay, card latency and the waiting-run check

Risk: normal · Depends on: **P4-T8b, P4-T4a**

## Description

Add three heavy scenarios (left out of the default and `--phase 4` runs; resolved point 15). `T4.L.05`: the 20 sensitive tickets from `evals/tickets.json` (those with a `sensitiveTopic`) are created through `test-tickets` (`testId` `<runId>:L05:<evalId>`), at most 5 at a time; each must reach `review_pending` with a card in history within 120 seconds. Pass at 20/20 cards. It also measures DoD 1: for each ticket, the time from the `policy_decided` event to the `review_requested` event must be at most 10 seconds; the evidence lists the 20 values, the maximum and the p95. The tickets are then left to time out. `T4.F.01:start` creates one review ticket with `testOverrides: { reviewTimeout: "30m" }`, waits for its card and writes `{ ticketId, reviewId, slackTs }` to `.loop-evidence/live/f01-<runId>.json`. `T4.F.01:finish --from <file>` signs an approve for that review and expects `approved` within 5 seconds. The orchestrator deploys a new version to the E2E Trigger.dev project and rolls back between the two steps (DoD 8).
Env: none new.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] `T4.L.05` passes when the mock gives 20 cards. It fails, naming the eval ID, when one card is missing, and fails, naming the ticket, when one latency is 11 seconds.
- [ ] `T4.L.05` never has more than 5 ticket creations in flight (the mock records the peak), and reports the sum of `aiCallCount`.
- [ ] `T4.F.01:start` writes a file with the three IDs and nothing else; `T4.F.01:finish` passes when the mock approves, fails when the status is not `approved` within 5 seconds, and fails with a usage message when `--from` is missing or the file does not parse.
- [ ] The runner's default run and `--phase 4` select none of the three; `--only T4.L.05` selects it.

## Non-Goals

- The deploy and the rollback themselves (orchestrator, by hand). A full eval run.

## How to Test

- `pnpm --filter @ai-it-support/live-tests test`

## Assumptions

- The 20 sensitive tickets cost about 360 TypeSafe calls per run (about 18 per ticket; open question 1).

---

## Orchestrator steps (not filed)

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                   | When                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| O1  | Seun approves this spec; file the 24 tasks in ClickUp list `Build Loop` (start statuses as in the order table, HELD comments on the blocked ones)                                                                                                                                                                                                                                                      | Before building              |
| O2  | Pause the loop for H15 after P4-T1b merges; pre-test 0005 on `supabase/postgres:17.6.1.177` up → down → up (P4-T1b)                                                                                                                                                                                                                                                                                    | After P4-T1b                 |
| O3  | Preflight (plan §2.2 step 1): `GET /api/health/config` on the e2e app shows `migration0005` and `slackInteractivity` true; a `healthcheck` run on the E2E project shows `configured.slack` true; read `GET /api/internal/usage` for the month before every live run                                                                                                                                    | After H15 and the e2e deploy |
| O4  | Verify: `pnpm test:live --phase 4` twice in a row; `pnpm test:live --only T4.L.05` (budget per open question 1); T4.F.01: `--only T4.F.01:start`, deploy `dev` to the E2E project as a new version, roll back (redeploy the previous pipeline commit as a new version, PROJECT §11 2026-10-24), `--only T4.F.01:finish`; T4.R.01 by hand; Stryker on the guard modules (`pnpm test:mutation -- --all`) | After O3                     |
| O5  | Goal check on e2e (plan §6.2): HR complaint → card in `#itsupport-e2e` → signed approve → `approved`; a second sensitive ticket → signed reject → `rejected`, no further step. Then `docs/evidence/phase-4.md`, PROJECT §6/§11 lines, release PR with the `high-risk` task list                                                                                                                        | After O4                     |

## Human steps (not filed)

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Who                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| H14 | Done 2026-10-24: Slack app "IT Support Agent (demo)" with `chat:write`, `channels:history`, `channels:read`; interactivity URL `https://<staging-host>/api/slack/interactivity`; `#itsupport-e2e` created; bot invited to both channels; e2e test signing secret generated. Env per plan §5: `SLACK_BOT_TOKEN` (store `ITSUPPORT_SLACK_BOT_TOKEN`), `SLACK_SIGNING_SECRET` (staging: `ITSUPPORT_SLACK_SIGNING_SECRET`; e2e: `ITSUPPORT_E2E_SLACK_SIGNING_SECRET`), `SLACK_CHANNEL_ID` (staging `C0A4RJN780K`, e2e `C0CBR0YUNBV`), `SLACK_ALERT_CHANNEL_ID` (unset = the review channel), `SLACK_REVIEWER_IDS` (staging `U0A5ATR4WJD`, e2e `UE2EREVIEWER`), `SLACK_REVIEW_TIMEOUT` (main project `24h`, E2E project `2m`). The orchestrator's preflight (O3) confirms the names are set without reading values | You (done)                                     |
| H15 | Apply `supabase/migrations/0005_itsupport_reviews.sql` in Supabase Studio after P4-T1b merges, then run `supabase/checks/0005_itsupport_reviews.check.sql`. Every row must show `ok = true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | You (Claude pre-tests on a throwaway database) |
| H25 | Merge the `dev` → `main` release PR after reading the `high-risk` test files. Release UAT on staging: create one sensitive ticket, press Approve on the real card; create a second, press Reject. Claude confirms `approved` / `rejected` through the internal API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | You                                            |

## Coverage matrix: test ID → task

"Orchestrator verify" means the orchestrator runs the test on the e2e environment in step O4, with the script from the named task.

| Test ID | Owner                                                                                    |
| ------- | ---------------------------------------------------------------------------------------- |
| T4.U.01 | P4-T3a                                                                                   |
| T4.U.02 | P4-T3a                                                                                   |
| T4.U.03 | P4-T2a                                                                                   |
| T4.U.04 | P4-T3b                                                                                   |
| T4.I.01 | P4-T9a                                                                                   |
| T4.I.02 | P4-T9a (unit half P4-T4b)                                                                |
| T4.I.03 | P4-T3d (unit), P4-T9b (integration)                                                      |
| T4.I.04 | P4-T5 (unit), P4-T3d (handler half), P4-T9a (integration)                                |
| T4.I.05 | P4-T2c and P4-T5 (unit), P4-T9a (integration)                                            |
| T4.I.06 | P4-T3d (unit), P4-T9b (integration)                                                      |
| T4.I.07 | P4-T1b                                                                                   |
| T4.E.01 | P4-T9c                                                                                   |
| T4.L.01 | Orchestrator verify, script from P4-T8b                                                  |
| T4.L.02 | Orchestrator verify, script from P4-T8b                                                  |
| T4.L.03 | Orchestrator verify, script from P4-T8b                                                  |
| T4.L.04 | Orchestrator verify, script from P4-T8b                                                  |
| T4.L.05 | Orchestrator verify, script from P4-T8d (heavy)                                          |
| T4.S.01 | Local: P4-T3c, P4-T9b. Live: orchestrator verify, script from P4-T8c                     |
| T4.S.02 | Local: P4-T2b. Live: orchestrator verify, script from P4-T8c                             |
| T4.S.03 | Local: P4-T9b. Live: orchestrator verify, script from P4-T8c                             |
| T4.S.04 | Local: P4-T3d, P4-T9b. Live: orchestrator verify, script from P4-T8c                     |
| T4.S.05 | Floors switched on by P4-T3a, P4-T3b, P4-T3c (proven again in P4-T3d); gate from P3-T15d |
| T4.S.06 | P4-T8a                                                                                   |
| T4.X.01 | Local: P4-T2b. Live (judge J4): orchestrator verify, script from P4-T8b                  |
| T4.F.01 | Orchestrator verify: scripts from P4-T8d, deploy and rollback by hand                    |
| T4.R.01 | Orchestrator verify, by hand with Dokploy and Trigger.dev; no script                     |

## Coverage matrix: Definition of Done → proof

Phase 4 DoD (plan §6.2):

| DoD | Item                                                                                               | How it is proven                                                                |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Card within 10 s of `policy_decided` (≥ 10 live runs)                                              | T4.L.05 (P4-T8d): 20 samples of `review_requested` − `policy_decided`           |
| 2   | Card text redacted only; 0 canaries in `#itsupport-e2e` history                                    | T4.L.01 (P4-T8b) scans the real card; egress recorder in P4-T9a                 |
| 3   | Approve resumes within 5 s; Reject → `rejected`, no helpdesk step                                  | T4.L.02, T4.L.03 (P4-T8b); T4.I.01, T4.I.02 (P4-T9a); asserted again in phase 5 |
| 4   | Timeout → `escalated_manual`, thread note, no incident                                             | T4.L.04 (P4-T8b); T4.I.04 (P4-T5, P4-T9a)                                       |
| 5   | Bad signature, stale, non-allow-listed → 401 / 401 / 403 with `security_events`; replay is a no-op | T4.S.01 (P4-T8c live; P4-T3c, P4-T9b local)                                     |
| 6   | A second click changes nothing and says "already decided"                                          | T4.I.03 (P4-T3d, P4-T9b); the live replay in T4.S.01                            |
| 7   | 20 sensitive eval tickets replayed live → 20 cards                                                 | T4.L.05 (P4-T8d)                                                                |
| 8   | A waiting run survives a deploy and a rollback                                                     | T4.F.01 (P4-T8d scripts, `reviewTimeout` switch from P4-T4a, deploy by hand)    |

Universal DoD (plan §3):

| DoD | Item                                           | How it is proven                                                                                                                 |
| --- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tasks done, merged, reviewed                   | ClickUp and PR list; two reviews for each `high-risk` task in the order table                                                    |
| 2   | PROJECT §9 gates, coverage floors              | CI on the final `dev` commit; per-module floors for the three new guard modules                                                  |
| 3   | Mutation score ≥ 80 % on guards                | `pnpm test:mutation -- --all` (P4-T3a, P4-T3b, P4-T3c, P4-T3d); T4.S.05                                                          |
| 4   | Semgrep: no unaccepted high finding            | `semgrep` job (unchanged from phase 3)                                                                                           |
| 5   | Migration up, down, tested, applied            | T4.I.07 (P4-T1b); H15; `migration0005: true` in `/api/health/config` (P4-T7b)                                                    |
| 6   | `dev` deployed to e2e; `.env.example` complete | `pnpm deploy:pipeline` with the E2E ref; Dokploy deploy; `/api/health` 200; `configured.slack` (P4-T10); the `.env.example` test |
| 7   | Live suite green twice in a row                | `pnpm test:live --phase 4` twice (P4-T8a–c); T4.L.05 and T4.F.01 separately (heavy)                                              |
| 8   | Rollback rehearsed on e2e                      | T4.R.01 by hand, then `pnpm test:live --only T4.L.02`                                                                            |
| 9   | No PII canary in external sinks                | Slack history scan (T4.L.01), egress recorder (P4-T9a, P4-T9b), `pnpm scan:traces` and `pnpm scan:logs` on the phase's live runs |
| 10  | Goal check                                     | O5                                                                                                                               |
| 11  | Evidence file                                  | `docs/evidence/phase-4.md` with the reports from `.loop-evidence/` and the TypeSafe and LLM call counts of the phase             |
| 12  | PROJECT §6/§11 updated, release PR             | Orchestrator; §11 lines for resolved points 1, 4, 7 and 9                                                                        |
