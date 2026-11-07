# Phase 5 — Helpdesk connector, ServiceNow and reply email: task drafts (P5-T1–P5-T8)

Source: `docs/specs/2026-10-04-phases-3-8-plan.md` §6.3 (goal, migration, task table P5-T1–P5-T8, DoD 1–10, test plan `T5.*`, goal check) and §6.3.1 (built-in helpdesk, P5-T9–P5-T22, bundles P5-B1–P5-B15), with §1–§5 (§2.1 standing approval, §2.5 internal API, §2.6 status model, §4.2 personas, §4.3 canaries, §4.4 secrets in tests, §4.5 judges, §5 H16–H18, H26–H31); `docs/PROJECT.md` §5, §7–§9, §11; the format and names of `docs/specs/2026-10-25-phase-4-slack-review.md`.
Build-loop target repo: `D:/Homebase/Sandbox/ai-it-support-agent` (branch `dev`).
Status: approved 2026-11-06 (PR #142). Amended 2026-11-07 under goal G2: ticket numbers `ITS-000001` (Seun, format A; resolved points 20–23), migrations built first with one Studio sitting (resolved point 24), and Seun's one-sitting setup checklist. P5-B1–P5-B15 are already filed (§6.3.1); "ClickUp impact" at the end lists the filed descriptions that now differ.

Goal (plan §6.3): auto-routed and approved tickets become exactly one ServiceNow incident on `dev420188` with a correct category and caller; rejected or escalated tickets never do. All helpdesk access goes through `HelpdeskConnector`. `SHADOW_MODE` blocks every write. A sleeping instance is reported clearly and tickets wait safely. The requester gets one email with the incident number and fix steps. With `HELPDESK=builtin` the same tickets go to the built-in helpdesk instead (§6.3.1; not restated here).

Decisions used: plan D2 (Seun applies migrations), D7 (reply email via Resend, allow-listed recipients only on staging), D10 (E2E Trigger.dev project), C5 (test switches only on e2e test tickets), C6 (checks through the internal API), C8 (caller is the requester, by email), C13 (evals through the real pipeline), C14 (namespaced idempotency keys), G1–G2 and G9 of §6.3.1 where this spec touches them. Seun's decisions 2026-11-05: 1A (staff see redacted text only), 2B (an admin may Approve or Reject from the ticket page through the same decision path as Slack; `high-risk`), 3A (high-risk PRs keep the ~200-line cap). PROJECT §11: 2026-10-08 (lean mode), 2026-10-24 (at most 2 full eval runs per phase per month), 2026-10-26 (scope: phases 3–5 plus the final release are required; phases 6–8 are optional), 2026-11-05 (built-in helpdesk, option B).

## Rules for every task

- Size: one PR per task part. A normal part is ~450 changed lines or fewer, tests included (lean mode, PROJECT §7). A `high-risk` part is ~200 changed lines or fewer (Seun 3A). If a part grows past its cap, the builder stops and asks for a split.
- Risk (lean mode, PROJECT §11 2026-10-08 and 2026-10-26): `high-risk` only for shared-database migrations, redaction, and Slack or decision code. In P5-T1–P5-T8 that is migration 0006 only (P5-T1a, P5-T1b); the ticket-number display parts P5-T1c and P5-T1d are normal. They need two independent reviews; every other part needs one (resolved point 3).
- Tests: happy path, failure path and edge case for every unit of logic (PROJECT §8). Write the tests first and see them fail.
- Privacy: only redacted text leaves the system. ServiceNow and Resend are external sinks. An incident field, a work note or an email body holds only redacted text, enum values, IDs, the incident number and fixed wording. The requester email is sent to exactly two places: the ServiceNow `sys_user` lookup (as the `email` query parameter) and Resend's `to` field. It never goes into an incident field, a note, an email body, an event payload or a log line. Staff see redacted text only (1A, §6.3.1 G8).
- Fail loudly: typed errors, no default text, no swallowed error. A best-effort step (a notification trigger, an alert post) logs the error class name and raises an alert where this spec says so; it never fails silently.
- New env names go into a shape in `packages/shared/src/env.ts` and into `.env.example`, and `packages/shared/test/env-example.test.ts` must pass. ServiceNow and Resend values are pipeline-only; the web app gets no ServiceNow or Resend variable.
- A new root file or folder goes into the allow-list in `packages/shared/test/repo-layout.test.ts` in the same PR. The new package `packages/helpdesk` is covered by the existing `packages/*` globs; the new root folder `scripts/` is not (P5-T7 adds it).
- New dependency: none. ServiceNow's Table API and Resend's API are called with `fetch`. A part that still needs one says so in its report (one line for PROJECT §11).
- Secret-shaped test data is built at run time or imported from `packages/shared/src/canaries.ts`. ServiceNow passwords and Resend keys in tests are built from pieces, so gitleaks stays green.
- Do not schema-qualify built-in SQL functions. The schema-scope test allows only `itsupport` and `extensions`.
- Agents never connect to the shared database and never apply a migration (H28b). They never read or print a key-store value. A test process never holds the service-role key (plan §2.1, §4.4).
- `.github/workflows/ci.yml` does not change in phase 5.
- A guard module is listed in `guard-modules.json` with `statements: 90` and `mutation: 80` by the part that creates it. In P5-T1–P5-T8: the shadow wrapper (P5-T4) and the sync guard (P5-T5a) (plan T5.S.03). A builder runs mutation only for the guard modules it touches; CI judges `pnpm test:mutation -- --all` (PROJECT §11 2026-10-26).
- AI budget: at most 2 full eval runs per phase per month (PROJECT §11 2026-10-24). Phase 5 makes no full eval run. Local and CI tests never call TypeSafe, the LLM, ServiceNow or Resend (they are mocked with `msw`). A live scenario creates as few tickets as it can, reuses them for its sub-checks, closes the `[E2E]` incidents it created when it ends, and reports the sum of `aiCallCount` of its tickets in its evidence. `T5.L.02`, `T5.L.08` and `T5.F.01` are `heavy`: the default run and `--phase 5` leave them out; they run only with `--only`.
- Real ServiceNow is reached only by the e2e pipeline, by the live scenarios through the guarded ServiceNow helper (P5-T7), and by Seun's background script (H16). Real Resend is reached only by the e2e pipeline and, read-only, by the guarded Resend helper (P5-T8c).

## Names used across tasks

- Migration numbers (resolved point 1): `0005` is the phase 4 reviews migration. Phase 5's notifications and ticket-number migration is `0006_itsupport_helpdesk`. The built-in helpdesk adds `0007_itsupport_builtin_helpdesk` and `0008_itsupport_staff_access`, as §6.3.1 says. Seun applies all three in one sitting, H28b (resolved point 24).
- Ticket number (0006, resolved points 20–23): column `itsupport.tickets.ticket_number` (`text`, not null, unique, check `^ITS-[0-9]{6}$`), filled by the default `itsupport.next_ticket_number()` over the sequence `itsupport.ticket_number_seq` (1–999 999, no cycle). Display only: the ticket UUID stays the only key used to open or act on a ticket. API and code name: `ticketNumber` (the internal view's field is `number`). Type rule `TICKET_NUMBER_RE` in `packages/shared/src/ticket.ts`. Not to be confused with the ServiceNow incident number (`INC…`) or the built-in helpdesk number (`HD…`).
- Statuses used in phase 5 (plan §2.6): `triaged` → `auto` → `helpdesk_pending` → `incident_created` | `incident_skipped_shadow`; `review_pending` → `approved` → `helpdesk_pending` → …; `rejected` and `escalated_manual` never reach `helpdesk_pending`; any status → `failed`.
- Table `itsupport.notifications` (0006): `id`, `ticket_id`, `channel` (`email`), `kind` (`incident_reply` | `needs_info`), `status` (`sent` | `skipped` | `failed`), `provider_id` (nullable), `reason` (nullable; `not_allow_listed` | `provider_error`), `at`. Unique `(ticket_id, channel, kind)`. Index `tickets_servicenow_sys_id_idx` on `tickets(servicenow_sys_id)`.
- Package `packages/helpdesk` (`@ai-it-support/helpdesk`): `HelpdeskConnector`, `HelpdeskTicketRef` (`{ externalId, number }`), `CreateHelpdeskTicketInput` (`ticketId`, `isTest`, `redactedTitle`, `redactedDescription`, `category`, `priority`, `assignmentGroup` (nullable), `requesterEmail` (nullable)), `HelpdeskTicketState` (`new` | `in_progress` | `on_hold` | `resolved` | `closed`, the G3 names), `ShadowSkip` (`{ skipped: "shadow" }`), `FakeConnector`, `runHelpdeskContract`, `ServiceNowConnector`, `withShadowMode`.
- Helpdesk errors: `HelpdeskError` with `code` (`asleep` | `auth` | `not_found` | `bad_request` | `rate_limited` | `unavailable` | `bad_response` | `config` | `duplicate_external_ref`) and `retryable` (true only for `asleep`, `rate_limited`, `unavailable`); `InstanceAsleepError` extends it with `code: "asleep"`. Messages name the operation and the code, never a value.
- Tasks: `helpdesk-sync` (`HELPDESK_SYNC_TASK_ID`, payload `{ ticketId, testOverrides? }`, trigger key `helpdesk-sync:<ticketId>`); `helpdesk-health` (scheduled, every 30 minutes, output `{ connector, status, checkedAt }`); `notify-requester` (`NOTIFY_REQUESTER_TASK_ID`, payload `{ ticketId, kind }`, trigger key `notify:<ticketId>:<kind>`).
- New ticket events (payload IDs, enums and the incident number only, never text): `helpdesk_sync_started {}`, `incident_created { externalId, number }`, `helpdesk_note_added { externalId }`, `caller_defaulted {}`, `shadow_skipped { operation }`, `sync_refused { status }`, `helpdesk_asleep { attempt }`, `helpdesk_sync_failed { error }`, `helpdesk_enqueue_failed { error }`, `notification_sent { notificationId }`, `notification_skipped { notificationId, reason }`, `notification_failed { notificationId, error }`, `notify_enqueue_failed { error }` (`error` is an error class name or a `HelpdeskError` code).
- New `AlertKind`s (source `pipeline`): `alert:helpdesk_auth_failed`, `alert:helpdesk_sync_failed`, `alert:helpdesk_asleep_timeout`, `alert:helpdesk_config`, `alert:sync_refused`, `alert:helpdesk_asleep`, `alert:helpdesk_down`, `alert:notify_failed`, `alert:notify_enqueue_failed`.
- Test switches (plan C5) added in phase 5: `shadowMode` (only the value `true`; it can turn shadow mode on, never off) and `helpdeskAsleepMinutes` (a whole number 1–30: the connector acts asleep for that ticket until that many minutes after the ticket's `created_at`).
- Env, pipeline: `SERVICENOW_INSTANCE_URL` (`https://<name>.service-now.com`, no path), `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD`, `SERVICENOW_DEFAULT_CALLER` (a `sys_user` sys_id, 32 lower-case hex), `SHADOW_MODE` (exists), `RESEND_API_KEY` (`^re_[A-Za-z0-9_]{20,}$`), `REPLY_FROM` (one address on the verified domain), `REPLY_ALLOWED_RECIPIENTS` (1–20 distinct lower-case addresses, comma-separated, no spaces). `HELPDESK` arrives with P5-T14 (§6.3.1). Env, live tests only: `E2E_SERVICENOW_INSTANCE_URL`, `E2E_SERVICENOW_USERNAME`, `E2E_SERVICENOW_PASSWORD`, `E2E_RESEND_READ_KEY`, `E2E_REPLY_RECIPIENT`.
- Persona emails (resolved point 13): `demo.<name>@example.com`, except `demo.carol`, whose email is Seun's allow-listed mailbox when the seed script's `REPLY_MAILBOX` is set (H16).
- Internal ticket view (§2.5): gains `number` (the ticket number, P5-T1c), `incident` (`{ number, sysId } | null`, P5-T5b) and real `notifications` entries (`{ id, channel, kind, status, reason, providerId, at }`, P5-T8b). P5-T22's `helpdesk { kind, number, state }` is separate (§6.3.1).
- Health (`/api/health/config`, booleans only): `migration0006` (P5-T8b), `helpdeskReachable` and `helpdeskAsleep` (P5-T6). The pipeline `healthcheck` task's `configured` map gains `servicenow` and `resend`.
- `environment`: `e2e` when `E2E_MODE=true`, else `staging`.

## Resolved points (orchestrator, needs Seun's OK)

The plan is silent on these; each is the smallest choice the orchestrator could find. The part that uses a point names it.

1. Migration numbering. Phase 4 used `0005` for reviews (phase 4 resolved point 1). The phase 5 notifications migration is `0006_itsupport_helpdesk.sql` (+ `.down.sql`, + `supabase/checks/0006_itsupport_helpdesk.check.sql`); §6.3.1 already says so, and its built-in migrations are `0007` and `0008`. This PR corrects the plan's §6.3 text and task table, the T5.I.07 row and H18 from `0005` to `0006`, with no other plan change. §6.3.1's numbers for phase 6 (`0009`) and phase 7 (`0010`) replace phase 4 resolved point 1's `0007`/`0008`; the plan's H20 and H23 rows still show the old numbers and are left for a later plan fix (they are optional phases).
2. `notifications` gets `kind` and the unique key `(ticket_id, channel, kind)` beyond the plan's list, so "one email per ticket" holds for each of the two email kinds, and a retried task cannot send twice.
3. Lean mode lowers P5-T3 (ServiceNow connector) and P5-T4 (shadow wrapper) from the plan's `high-risk` to normal: they are not migrations, redaction, Slack or decision code. Their safety is kept by tests: T5.U.02 (query injection), the egress recorder (redacted text only), and guard-module floors (90 % statements, 80 % mutation) on the shadow wrapper and the sync guard. Only P5-T1a and P5-T1b are `high-risk` in this spec.
4. Plan tasks are split into parts so each PR fits its cap: P5-T1 → a–b, P5-T3 → a–b, P5-T5 → a–c, P5-T8 → a–c; P5-T2, P5-T4, P5-T6 and P5-T7 are single parts. §6.3.1's references keep their meaning: "P5-T1" is P5-T1a + P5-T1b; "P5-T2–T5" in P5-B7 is the code parts P5-T2, P5-T3a–b, P5-T4, P5-T5a–b (P5-T5c is live test code only).
5. Phase 4 left `auto` tickets at `triaged` and `approved` tickets without a next step. P5-T5b adds both triggers: `triage-ticket` moves an `auto` ticket to `auto` and starts `helpdesk-sync`; `review-ticket` starts `helpdesk-sync` after `approved`. `rejected`, `escalated_manual` and `failed` start nothing.
6. "The update path" (DoD 5) is one work note that `helpdesk-sync` adds after it creates the incident: fixed wording plus category, priority, group, KB slugs and the redacted fix steps. It is written once (`helpdesk_note_added`).
7. ServiceNow field mapping: category is the identity map over the 6 categories (unknown throws); priority sets `impact`/`urgency` P1 = 1/1, P2 = 1/2, P3 = 2/2, P4 = 2/3 (stock priority matrix, checked at build); states `new` = 1, `in_progress` = 2, `on_hold` = 3 (with `hold_reason` 1, Awaiting Caller), `resolved` = 6, `closed` = 7 (`resolved` and `closed` set `close_code` `Closed/Resolved by Caller` and a fixed `close_notes`); `correlation_id` = ticket ID; `correlation_display` = the ticket number (resolved point 23); `short_description` = redacted title (`[E2E] ` prefix for test tickets), cut to 160 characters; `description` = the redacted description.
8. Caller: the requester email is looked up only when it is one address matching a strict rule and holds no `^`, `=`, `,`, CR, LF or NUL. Exactly one active `sys_user` → its sys_id; zero, two or more, or a refused value → `SERVICENOW_DEFAULT_CALLER` (the sys_id of `svc.itsupport` itself, added 2026-11-07) and the event `caller_defaulted`. Assignment group: the triage group name is looked up by exact name in `sys_user_group` (cached per connector instance); none found → `HelpdeskError` `config` (not retryable), the ticket fails with `alert:helpdesk_config`. The persona verify script (P5-T7) checks the 6 groups and 6 categories exist first.
9. Instance asleep: `helpdesk-sync` catches `InstanceAsleepError`, writes `helpdesk_asleep { attempt }`, keeps `helpdesk_pending`, and waits with `wait.for` (checkpointed, not compute time) 1, 2, 4, 8, 15, 30, then 60 minutes between tries, up to 6 hours after the first asleep answer. Then: `helpdesk_sync_failed { error: "asleep" }`, status `failed`, `alert:helpdesk_asleep_timeout`. Seun re-runs a failed ticket by hand; nothing is lost because the ticket and its triage stay stored.
10. Health (P5-T6): the web app has no ServiceNow credentials, so `/api/health/config` reads the output of the latest completed `helpdesk-health` run through the Trigger.dev SDK (the web app already holds `TRIGGER_SECRET_KEY`), cached 60 seconds. `helpdeskReachable` is true when that run is at most 45 minutes old and said `ok`; `helpdeskAsleep` is true when it said `asleep`. No new table. Live, DoD 7 is shown by the ticket-level switch (`helpdesk_asleep` events, T5.F.01); the health flag's `asleep` value is proven by P5-T6's tests with the real hibernation sample, and on staging if the instance really sleeps.
11. Test switches `shadowMode` and `helpdeskAsleepMinutes` (names above), honoured only with `E2E_MODE=true` and `is_test = true` (C5). `shadowMode` accepts only `true`, so a payload can make a run safer, never less safe.
12. `SHADOW_MODE`: `false` on the E2E project (so live tests create real `[E2E]` incidents), `true` on the main project until Seun decides at the phase 5 release (H16).
13. Personas: `demo.<name>@example.com` (reserved domain, never delivered). The seed script takes one optional parameter, `REPLY_MAILBOX`; when set, `demo.carol`'s email is that mailbox, which Seun also puts in `REPLY_ALLOWED_RECIPIENTS` (H17). So the goal check (printer fault as `demo.carol`, reply email received) works, and every other persona's email is skipped as not allow-listed. The live tests learn the address from `E2E_REPLY_RECIPIENT` (not a secret).
14. Live-test credentials: the plan's §4.4 gives tests the ServiceNow integration password from phase 6; phase 5 needs it now, as `E2E_SERVICENOW_*` (the same `svc.itsupport` user), to read incidents by `correlation_id`, run the live contract suite and close `[E2E]` incidents (§2.1 item 7). Resend `delivered` and the email body can only be read with a full-access key, so H17 adds a second Resend key for tests only, `ITSUPPORT_E2E_RESEND_READ_KEY` → `E2E_RESEND_READ_KEY`; the helper only ever sends GET.
15. `needs_info` email: `review-ticket` starts `notify-requester { kind: "needs_info" }` after `review_requested` when the triage flags hold `needs_info`. "What is missing" is a fixed checklist (what you were doing, the exact error message, when it started, which device or app), never ticket-derived text.
16. Email rules: no email in shadow mode, for `rejected`, `escalated_manual` or `failed` tickets, or without an incident number (except `needs_info`). The subject is fixed text plus the ticket number (`ITS-…`), and the body names both the ticket number and the helpdesk number (`^(INC[0-9]{7,}|HD[0-9]{7})$`, so built-in numbers work too; resolved point 22); test tickets get an `[E2E] ` subject prefix. `REPLY_FROM` is `help@<project domain>` on both Trigger.dev projects. The fix steps pass `redact` once more before they go into the body.
17. MIGRATIONS: P5-T1b adds `0006` to `packages/db/integration/rest-stack.ts`, so §6.3.1 P5-T10b's "add 0006 and 0007" adds only `0007`.
18. Live scenarios `T5.S.01` and `T5.L.06` hold canary text, which may route a ticket to `review`. Then the scenario signs an approve as the e2e test reviewer (P4-T6 helper) and goes on; the evidence records the route. `T5.L.02`'s 10 tickets are the eval tickets labelled `auto`; a ticket routed `review` live fails the scenario, naming the eval ID (a triage miss becomes a fix task, plan §2.2 step 7). Their requesters are `e2e-load+<n>@example.com`, so no email is sent.
19. Live run size: the default `--phase 5` run creates 9 tickets (P5-T5c: 6, P5-T8c: 3) and 1 direct contract incident (T5.C.02), about 160 TypeSafe calls and 3 judge calls (J1, J3, J4); two runs in a row double that. The heavy runs add 11 tickets. The orchestrator reads `GET /api/internal/usage` before each run and stops at 80 % of a cap (plan §2.3).
20. Ticket numbers (Seun, format A, 2026-11-07): `ITS-` plus 6 zero-padded digits (`ITS-000001`, `ITS-000002`, …), counting up by 1. **Display only.** The ticket UUID stays the only key used to open or act on a ticket: URLs, the internal API path, Slack button values, wait tokens, trigger and idempotency keys, `correlation_id` and every repository call take the UUID. No route, action or API accepts a ticket number as an identifier; a ticket number where a UUID is expected gets the same 400/404 as any other non-UUID (T5.S.07). The number is not personal data and may appear in Slack, ServiceNow, email and the staff screens.
21. How 0006 makes the number without breaking the 0004 sequence lock: 0004 removed every right on `itsupport` sequences from `public`, `anon`, `authenticated` and `service_role`, and a column default runs with the inserting role's rights. So the default is `itsupport.next_ticket_number()`, a `security definer` function (`set search_path = ''`) that returns `'ITS-' || lpad(nextval('itsupport.ticket_number_seq')::text, 6, '0')`; `execute` is revoked from `public`, `anon` and `authenticated` and granted to `service_role` only. No role gets a sequence right, so the 0004 check query stays all `ok = true`. Existing tickets are numbered by a backfill in `created_at` order (ties broken by `id`), and the sequence is set to continue after the highest backfilled number. At `ITS-999999` the next insert fails loudly (`nextval` reaches `maxvalue`); a wider format would be a later migration, far beyond demo volume. `service_role` could still write the column by hand; intake never sends it (P5-T1c), and since the number is display only, a wrong value misleads but never opens the wrong ticket.
22. Where the number appears, and which part owns it: the intake API response and the form confirmation page, the internal ticket view (P5-T1c); the Slack review, decided and timed-out cards, `Ticket ITS-000042 · …` instead of the 8-character UUID prefix (P5-T1d); the reply emails (P5-T8a, P5-T8b); the ServiceNow incident (P5-T3b); the staff list and ticket page, and the staff column grant (amendments to P5-B4, P5-B10 and P5-B11, section "Amendments to §6.3.1 bundles").
23. ServiceNow: the smallest choice is the stock field `correlation_display`, which already gets a fixed value (`ai-it-support`); it now gets the ticket number. `short_description` and its 160-character rule stay as they are, and `correlation_id` stays the UUID for `findByExternalRef`.
24. Order under goal G2: all migrations are built first, so Seun applies 0006, 0007 and 0008 in one Studio sitting (H28b, replacing H18, H28 and H29). The migration group is P5-T1a, P5-T1b, P5-B1, P5-B2, P5-B4, P5-B5, P5-B6, plus P5-B3, because P5-B6's parity test needs the state rules from P5-T9 (in P5-B3). A dependency on a migration means "merged to `dev` and tested on the local stack", never "applied to the shared stack": P5-B4 needs 0007 in the local `MIGRATIONS` list (P5-B2), not H28b. Every other part starts only after P5-B6 merges (held as `blocked`, G2). Nothing that reads 0006–0008 objects is deployed to e2e before H28b.

## Order

The loop builds one part at a time and ignores dependencies. So only parts with no dependency start in `backlog`; every other part is filed as `blocked` with a HELD comment and is released when its dependencies are merged to `dev`. The table covers P5-T1–P5-T8 (this spec) and P5-B1–P5-B15 (plan §6.3.1, already filed; their sections there are the specification and are not restated). It is in build order, which is a valid topological order.

Start in `backlog`: P5-T1a only. Under G2 every non-migration part is held until P5-B6 merges, even when it has no code dependency (resolved point 24). P5-B8, already filed in `backlog`, moves to `blocked` (HELD, G2).

| #   | ID     | Title                                                     | Risk                      | Reviews | Est. lines | Depends on                              | Status at filing       |
| --- | ------ | --------------------------------------------------------- | ------------------------- | ------- | ---------- | --------------------------------------- | ---------------------- |
| 1   | P5-T1a | Migration 0006, part 1: `notifications`, ticket number    | high-risk                 | 2       | ~200       | —                                       | backlog                |
| 2   | P5-T1b | Migration 0006, part 2: number backfill, seeded test      | high-risk                 | 2       | ~200       | P5-T1a                                  | blocked (HELD)         |
| 3   | P5-B1  | Migration 0007 tables (§6.3.1)                            | high-risk                 | 2       | ~200       | P5-T1b                                  | filed (§6.3.1)         |
| 4   | P5-B2  | Migration 0007 seeded test (§6.3.1)                       | high-risk                 | 2       | ~200       | P5-B1                                   | filed (§6.3.1)         |
| 5   | P5-B3  | State rules + helpdesk repositories (§6.3.1)              | normal                    | 1       | ~420       | P5-B2                                   | filed (§6.3.1)         |
| 6   | P5-B4  | Migration 0008 read access (§6.3.1, amended)              | high-risk                 | 2       | ~200       | P5-B2 (0007 local)                      | filed (§6.3.1)         |
| 7   | P5-B5  | Migration 0008 staff functions (§6.3.1)                   | high-risk                 | 2       | ~200       | P5-B4                                   | filed (§6.3.1)         |
| 8   | P5-B6  | Migration 0008 seeded test + scripts (§6.3.1)             | high-risk                 | 2       | ~200       | P5-B5, P5-B3                            | filed (§6.3.1)         |
| —   | H28b   | Seun applies 0006 → 0007 → 0008 in one sitting            | human                     | —       | —          | P5-B6                                   | not filed              |
| 9   | P5-T1c | Ticket number: intake, view, form confirmation            | normal                    | 1       | ~250       | P5-T1b, G2 hold                         | blocked (HELD, G2)     |
| 10  | P5-T2  | `packages/helpdesk`: interface, `FakeConnector`, contract | normal                    | 1       | ~400       | G2 hold                                 | blocked (HELD, G2)     |
| 11  | P5-T7  | Persona seed script, verify script, ServiceNow helper     | normal                    | 1       | ~400       | G2 hold                                 | blocked (HELD, G2)     |
| 12  | P5-T8a | Reply email template and Resend client                    | normal                    | 1       | ~360       | G2 hold                                 | blocked (HELD, G2)     |
| 13  | P5-B8  | Local GoTrue harness (§6.3.1)                             | normal                    | 1       | ~250       | G2 hold                                 | filed → blocked (HELD) |
| 14  | P5-T1d | Ticket number on the Slack cards                          | normal                    | 1       | ~150       | P5-T1c                                  | blocked (HELD)         |
| 15  | P5-T3a | ServiceNow client, errors, encoding, category map         | normal                    | 1       | ~380       | P5-T2                                   | blocked (HELD)         |
| 16  | P5-T4  | Shadow-mode wrapper and the `shadowMode` switch           | normal                    | 1       | ~220       | P5-T2                                   | blocked (HELD)         |
| 17  | P5-T3b | `ServiceNowConnector` and the live contract run           | normal                    | 1       | ~430       | P5-T3a, P5-T7, P5-T1c                   | blocked (HELD)         |
| 18  | P5-T6  | `helpdesk-health` task and the health flags               | normal                    | 1       | ~280       | P5-T3b                                  | blocked (HELD)         |
| 19  | P5-T5a | `helpdesk-sync` task                                      | normal                    | 1       | ~450       | P5-T1b, P5-T3b, P5-T4                   | blocked (HELD)         |
| 20  | P5-T5b | Sync triggers, ticket view `incident`, local runner       | normal                    | 1       | ~320       | P5-T5a                                  | blocked (HELD)         |
| 21  | P5-T8b | `notify-requester` task, notifications, view and flag     | normal                    | 1       | ~420       | P5-T8a, P5-T1b, P5-T1c, P5-T5b          | blocked (HELD)         |
| 22  | P5-B7  | `BuiltinConnector` + selector (§6.3.1)                    | normal                    | 1       | ~440       | P5-B3, P5-T2, P5-T3a–b, P5-T4, P5-T5a–b | filed (§6.3.1)         |
| 23  | P5-T5c | Live scenarios: incidents, shadow, asleep                 | normal                    | 1       | ~420       | P5-T5b, P5-T7, P5-T3b                   | blocked (HELD)         |
| 24  | P5-B9  | Staff login + session guard (§6.3.1)                      | high-risk                 | 2       | ~200       | P5-B8, P5-B6                            | filed (§6.3.1)         |
| 25  | P5-T8c | Live scenarios: reply email, canaries, log scan           | normal                    | 1       | ~380       | P5-T8b, P5-T5c                          | blocked (HELD)         |
| 26  | P5-B10 | Ticket list (§6.3.1, amended)                             | normal                    | 1       | ~310       | P5-B9, P5-T1c                           | filed (§6.3.1)         |
| 27  | P5-B11 | Ticket page (§6.3.1, amended)                             | normal                    | 1       | ~310       | P5-B10                                  | filed (§6.3.1)         |
| 28  | P5-B12 | Staff actions (§6.3.1)                                    | normal                    | 1       | ~400       | P5-B11                                  | filed (§6.3.1)         |
| 29  | P5-B13 | Admin review decision + parity (§6.3.1, 2B)               | high-risk (decision code) | 2       | ~200       | P5-B12                                  | filed (§6.3.1)         |
| 30  | P5-B14 | Staff suites (§6.3.1)                                     | normal                    | 1       | ~430       | P5-B13, P5-B7                           | filed (§6.3.1)         |
| 31  | P5-B15 | Live built-in scenarios (§6.3.1)                          | normal                    | 1       | ~250       | P5-B14, H26–H31                         | filed (§6.3.1)         |

"G2 hold" means the part waits for P5-B6 to merge (resolved point 24). Rows 1–8 can be built while Seun works through the setup checklist ("Seun setup — one sitting (G2)"); the H28b sitting comes after row 8.

Plan task → parts: P5-T1 → a–d (c and d added 2026-11-07 for ticket numbers); P5-T3 → a–b; P5-T5 → a–c; P5-T8 → a–c; P5-T2, P5-T4, P5-T6 and P5-T7 are single parts. That is 16 parts to file (2 `high-risk`, 14 normal), about 5 260 lines. With the 15 bundles: 31 PRs, 9 of them `high-risk`.

Dependencies added by this spec, beyond the plan's table: P5-T3b waits for the ServiceNow helper from P5-T7 (it runs the live contract suite with it) and for the ticket number in the ticket row (P5-T1c); P5-T5c waits for P5-T7 (personas and the helper); P5-T8b waits for P5-T5b (the sync task starts the email) and P5-T1c (the number); P5-T8c waits for P5-T5c (shared live steps); P5-B10 waits for P5-T1c (the number in the staff list). P5-B1 waits for both migration parts of P5-T1 (P5-T1a, P5-T1b); P5-B7 waits for the code parts of P5-T2–T5 (resolved point 4).

Loop pause: one, H28b, after P5-B6 merges (resolved point 24). Under G2 the build goes on with the held parts while Seun applies the migrations, but nothing that reads 0006–0008 objects is deployed to e2e before H28b is done. Seun's setup steps (H16, H17, H26 part 2, H27) are needed before the first live run (O3), not before building; the checklist puts them before the sitting so everything is ready at once.
Orchestrator steps (O1–O6), human steps (H16, H17, H25–H27, H28b, H30, H31) and Seun's one-sitting checklist are at the end. They are not filed.

---

## P5-T1a — Migration 0006, part 1: `notifications`, the index and the ticket number

Risk: **high-risk** (database migration for the shared stack) · Depends on: nothing

## Description

Plan §6.3 migration, numbered 0006 (resolved point 1). Create `supabase/migrations/0006_itsupport_helpdesk.sql`, `supabase/migrations/0006_itsupport_helpdesk.down.sql` and the read-only check query `supabase/checks/0006_itsupport_helpdesk.check.sql`. Up: `itsupport.notifications` with `id uuid` primary key default `gen_random_uuid()`; `ticket_id uuid not null` with a foreign key to `itsupport.tickets (id)` on delete restrict; `channel text not null` (check `email`); `kind text not null` (check `incident_reply` or `needs_info`; resolved point 2); `status text not null` (check `sent`, `skipped` or `failed`); `provider_id text` (nullable); `reason text` (nullable; check `not_allow_listed` or `provider_error`); `at timestamptz not null default now()`. Constraint `notifications_ticket_channel_kind_key`: unique `(ticket_id, channel, kind)`. Row checks: `sent` needs a `provider_id` and no `reason`; `skipped` needs `reason = 'not_allow_listed'` and no `provider_id`; `failed` needs `reason = 'provider_error'`. Index `tickets_servicenow_sys_id_idx` on `itsupport.tickets (servicenow_sys_id)` (`if not exists`). Ticket number (resolved points 20–21): the sequence `itsupport.ticket_number_seq` (`as integer`, `minvalue 1`, `maxvalue 999999`, `no cycle`); the function `itsupport.next_ticket_number()` (`security definer`, `volatile`, `set search_path = ''`; execute revoked from `public, anon, authenticated`, granted to `service_role`); the column `itsupport.tickets.ticket_number text` with constraint `tickets_ticket_number_key` (unique) and `tickets_ticket_number_format` (check `ticket_number ~ '^ITS-[0-9]{6}$'`), the default `itsupport.next_ticket_number()`, and `not null`. The up file leaves a marked place right after the `add column` for the backfill that P5-T1b adds, before the default and `not null` are set (on an empty table the order makes no difference). RLS on, no policies. `revoke all on table itsupport.notifications from public, anon, authenticated`; grant `select, insert, update` to `service_role` (no delete). Header comments: shared stack, idempotent, human step H28b, apply as one transaction, and the down file is destructive (it drops every notification row, the index and every ticket number). Down: drop the ticket-number default, the column `ticket_number`, the function and the sequence, then the index and the table. The check query returns one row per object, `(object text, ok boolean)`: the table, each named constraint, the index, RLS on, no right for `public`, `anon` or `authenticated`; and for the ticket number: the column (not null, with the default), `tickets_ticket_number_key`, `tickets_ticket_number_format`, the sequence, the function with `execute` for `service_role` only, no sequence right for any of the four roles, and no ticket without a number. Add `packages/db/integration/migration-0006.integration.test.ts`, which applies 0001–0005 first.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] On `supabase/postgres:17.6.1.177` with 0001–0005 applied, the up file exits 0, and `information_schema.columns` shows the 8 columns with the listed types and nullability; `pg_indexes` shows `tickets_servicenow_sys_id_idx`.
- [ ] A `sent` email notification for a ticket inserts; a second `incident_reply` for the same ticket fails with SQLSTATE `23505`; a `needs_info` for the same ticket inserts.
- [ ] Each of these fails with `23514`: `channel = 'sms'`; `kind = 'other'`; `status = 'queued'`; `sent` without `provider_id`; `sent` with a `reason`; `skipped` with `reason = 'provider_error'`; `skipped` with a `provider_id`; `failed` without a `reason`.
- [ ] A `ticket_id` that does not exist fails with `23503`; deleting a ticket that has a notification fails with `23503`.
- [ ] As `anon` and `authenticated`, select and insert on `notifications` fail with `42501`. As `service_role`, insert, select and update work, and delete fails with `42501`.
- [ ] Up twice exits 0. Down drops the table and the index and leaves every 0001–0005 object in place; down twice exits 0; up after down works.
- [ ] Ticket number: three tickets inserted as `service_role` without a number get `ITS-000001`, `ITS-000002`, `ITS-000003`; `ticket_number = 'ITS-1'`, `'its-000004'` and `'ITS-0000005'` fail with `23514`; a duplicate number fails with `23505`; `null` fails with `23502`.
- [ ] As `anon` and `authenticated`, `select itsupport.next_ticket_number()` fails with `42501`; no role of `public`, `anon`, `authenticated` or `service_role` has a right on `ticket_number_seq` (`has_sequence_privilege` false for every right), and the 0004 check query still returns only `ok = true`.
- [ ] With the sequence set to 999 999 (test only), the next insert fails with `2200H`, and no number past `ITS-999999` exists.
- [ ] The check query returns `ok = true` for every row after up, and `ok = false` for the `notifications`, index and ticket-number rows after down; after down `tickets` has no `ticket_number` column and the sequence and function are gone.
- [ ] The schema-scope test (`packages/db/test/migration-schemas.test.ts`) passes for both 0006 files.

## Non-Goals

- Applying the migration to the shared Supabase (H28b). Agents never connect to the shared database.
- The backfill of existing tickets and the seeded up → down → up test (P5-T1b). Repository functions (P5-T8b). Showing the number anywhere (P5-T1c, P5-T1d).

## How to Test

- `pnpm --filter @ai-it-support/db test` · `pnpm test:integration`

## Assumptions

- 0004 note: 0004 revoked every right on `itsupport` sequences, and `notifications` has no identity column. The new `ticket_number_seq` is used only inside the `security definer` function, so no role needs a sequence right and the 0004 lock holds (resolved point 21). The function is owned by the role that applies the migration (Seun's Studio role, as for 0001–0005).
- Size: with the backfill moved to P5-T1b, this part stays near the ~200-line high-risk cap. If it still goes over, the builder stops and asks (rules).
- `tickets.servicenow_sys_id` and `tickets.servicenow_number` exist since 0001 and need no change.

---

## P5-T1b — Migration 0006, part 2: ticket-number backfill and up → down → up with seeded rows

Risk: **high-risk** (database migration for the shared stack) · Depends on: **P5-T1a**

## Description

The backfill, a test task and one list change. Backfill (resolved point 21): in the place P5-T1a marked, number every ticket whose `ticket_number` is null as `ITS-` + `lpad(row_number() over (order by created_at, id) + <highest existing number>, 6, '0')`, then `setval('itsupport.ticket_number_seq', <highest number>, true)` (or `setval(…, 1, false)` when there is no ticket), then the default and `not null` as before. It is idempotent: a second run finds no null and leaves the sequence where it was. Add `0006_itsupport_helpdesk.sql` to `MIGRATIONS` in `packages/db/integration/rest-stack.ts` (resolved point 17). Extend `migration-default-privileges.integration.test.ts` so its end state covers `notifications`. In `migration-0006.integration.test.ts`, seed phase-4-shaped rows first: three tickets (`triaged` with route `auto`, `approved`, `rejected`), their redactions, triage rows, events, one decided `reviews` row, `ai_calls` and `security_events` rows, and one ticket with `servicenow_sys_id` and `servicenow_number` set; two of the tickets share one `created_at`. Complete the header comments. Nothing pauses here: under G2 the single migration sitting H28b comes after P5-B6 (resolved point 24).
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T5.I.07**: with the seeded rows present, the whole up file, then the whole down file, then the up file again each exit 0. After each step the rows are unchanged apart from 0006's own objects (row counts, and an `md5` of each table's pre-0006 columns ordered by key).
- [ ] **T5.I.07**: after the second up, a second `incident_reply` for a seeded ticket fails with `23505`, and a lookup by `servicenow_sys_id` uses the index (`explain` shows `tickets_servicenow_sys_id_idx` with `enable_seqscan` off).
- [ ] **T5.I.09**: the backfill numbers the seeded tickets `ITS-000001` upwards in `created_at` order, the two with equal `created_at` in `id` order; the next new ticket gets the next number; after down → up the same tickets get the same numbers; running the up file twice changes no number and does not move the sequence.
- [ ] After down, the seeded notification rows and the ticket numbers are gone and no other table changed.
- [ ] After all migrations, the default-privileges test finds no right for `anon`, `authenticated` or `public` on any `itsupport` object, `notifications` and `next_ticket_number()` included, and no sequence right for `service_role`.
- [ ] Migration 0001's down file still removes the whole schema with 0006 applied.
- [ ] After the full up file the check query returns only `ok = true` rows for 0006.
- [ ] Every existing REST-stack integration test (db, shared, pipeline, web) passes with 0006 in `MIGRATIONS`, and `pnpm test:integration` exits 0.

## Non-Goals

- Applying the migration (H28b). The `migration0006` health flag (P5-T8b). Showing the number (P5-T1c, P5-T1d).

## How to Test

- `pnpm test:integration`

## Assumptions

- §6.3.1 P5-T10a applies 0001–0006 in its own test and P5-T10b adds only 0007 to `MIGRATIONS` (resolved point 17).
- The shared stack holds a few hundred tickets at most, so the backfill is one quick `update` inside the H28b transaction.

---

## P5-T1c — Ticket number in intake, the ticket view and the form confirmation

Risk: normal · Depends on: **P5-T1b** (and the G2 hold)

## Description

Resolved points 20 and 22. Add `TICKET_NUMBER_RE` (`^ITS-[0-9]{6}$`) and `ticketNumberSchema` to `packages/shared/src/ticket.ts`. `packages/db`: the ticket row schema gains `ticket_number`, and the intake insert reads it back (`select` after insert; the insert never sends `ticket_number`). `POST /api/tickets` and `POST /api/internal/test-tickets` answer `{ ticketId, ticketNumber, queued, duplicate? }`; a duplicate submit answers the first ticket's number. The internal ticket view gains `number`. The form confirmation (`apps/web/src/components/ticket-form.tsx`, "Ticket received") shows `Your ticket number is ITS-000042` and no longer prints the UUID. The UUID stays in every path, key and payload (resolved point 20). Update the live-suite mock and `tests/live` client schemas.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T5.U.06**: `ticketNumberSchema` accepts `ITS-000001` and `ITS-999999` and rejects `ITS-1`, `its-000001`, `ITS-0000001`, `ITS-00000a` and `INC0010001`.
- [ ] Integration (local REST stack, 0001–0006): a form submit answers `201` with a `ticketNumber` matching the rule; the next submit gets the next number; a duplicate submit with the same key answers the same `ticketId` and `ticketNumber`; the insert request body has no `ticket_number` key (spy).
- [ ] `GET /api/internal/tickets/:id` has `number`; the strict view schema rejects a view without it or with a bad format; T3.S.03 and the existing view tests pass.
- [ ] The confirmation renders `Your ticket number is ITS-000042` for a mocked response, has no UUID in its text, and passes the existing form DOM and axe tests in light and dark themes.
- [ ] **T5.S.07**: a ticket number used where a UUID is expected — `GET /api/internal/tickets/ITS-000001`, `POST /api/internal/test-tickets` with `ITS-000001` as an ID field, a Slack interactivity payload whose button value is `ITS-000001` — gets the same status as any other non-UUID (400 or 404) and reads nothing (repository spies).
- [ ] With a raw-title marker on the ticket, no response holds the marker; the `tests/live` mock and client tests pass.

## Non-Goals

- Slack cards (P5-T1d). Emails (P5-T8a–b). ServiceNow (P5-T3b). Staff screens (§6.3.1 P5-B10, P5-B11). Looking a ticket up by its number.

## How to Test

- `pnpm --filter @ai-it-support/shared test` · `pnpm --filter web test` · `pnpm --filter @ai-it-support/live-tests test` · `pnpm test:integration`

## Assumptions

- Requesters need a reference they can quote; the UUID was never meant for people (Seun A, 2026-11-07).

---

## P5-T1d — Ticket number on the Slack cards

Risk: normal (Slack card text, not signature or decision code; lean mode) · Depends on: **P5-T1c**

## Description

Resolved point 22. `packages/slack/src/card.ts` (phase 4 module, guard floors `statements: 90`, `mutation: 80` stay): `ReviewCardInput` gains `ticketNumber` (checked with `ticketNumberSchema`; a bad value throws `TypeError` that does not echo it). The review card's context line becomes `Ticket ITS-000042 · <environment> · decide within <timeout>, then it goes to the manual queue`, and the summary line of the decided and timed-out cards ends `· ticket ITS-000042`, in place of the first 8 characters of the UUID. `review-ticket` passes the stored `ticket_number`. Button values stay the review UUID. The thread steps and the timeout note do not change.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T5.U.05**: `buildReviewCard` with `ticketNumber: "ITS-000042"` has the context line `Ticket ITS-000042 · e2e · decide within 24h, then it goes to the manual queue`; `buildDecidedCard` and `buildTimedOutCard` summary lines end `· ticket ITS-000042`; no card holds the UUID prefix any more.
- [ ] `ticketNumber: "ITS-42"` or a missing number throws `TypeError` naming `ticketNumber`.
- [ ] Every card still passes `validateMessage` and `assertNoLiveMarkup`; the Approve and Reject values are still the review UUID.
- [ ] `review-ticket` passes the stored number to the card builders (unit test with fakes); the phase 4 card, review-ticket and live review mock tests pass with only the expected context strings updated.
- [ ] `pnpm test:mutation -- packages/slack/src/card.ts` stays at 80 % or more.

## Non-Goals

- Card layout or wording beyond the ticket reference. Changing what a click carries.

## How to Test

- `pnpm --filter @ai-it-support/slack test` · `pnpm --filter @ai-it-support/pipeline test` · `pnpm test:mutation -- packages/slack/src/card.ts`

## Assumptions

- Seun's card approval of 2026-10-25 covered the layout; the reference text inside the context line is his 2026-11-07 decision.
- Cards posted before this part keep the old prefix; they are not edited.

---

## P5-T2 — `packages/helpdesk`: interface, `FakeConnector` and the contract suite

Risk: normal · Depends on: nothing

## Description

Add the workspace package `packages/helpdesk` (`@ai-it-support/helpdesk`), set up like `packages/slack` (build to `dist/`, scripts `build`, `test`, `typecheck`, `lint`). `src/types.ts`: `HelpdeskConnector` with `kind` (`servicenow` | `builtin` | `fake`), `createTicket(input)` → `HelpdeskTicketRef & { callerDefaulted: boolean }`, `findByExternalRef(ticketId)` → `HelpdeskTicketRef | null`, `addNote(ref, body)`, `updateTicket(ref, { state })` (state one of `in_progress`, `on_hold`, `resolved`, `closed`), `health()` → `{ status: "ok" | "asleep" | "down" }`; write methods may also return `ShadowSkip` (used only by P5-T4). The input type has the fields in "Names used across tasks" and no field for raw text or a requester name. `src/errors.ts`: `HelpdeskError` and `InstanceAsleepError` (names above). Every method checks that `ticketId` is a UUID and that note bodies are 1–5 000 characters, and throws `TypeError` before any I/O otherwise. `src/fake.ts`: `FakeConnector`, in memory, numbers `FAKE0000001` upwards, with `failNext(code)`, `setAsleep(boolean)` and a `calls` record for tests. `src/testing/contract.ts`: `runHelpdeskContract(name, makeConnector, { cleanup?, isTest? })`, a Vitest suite any connector must pass: create → a ref with a non-empty `externalId` and `number`; `findByExternalRef` of that ticket ID → the same ref; an unknown ticket ID → null; `addNote` on the ref resolves; `addNote` on an unknown ref → `HelpdeskError` `not_found`; `updateTicket` `in_progress` → `resolved` → `closed` each resolve; a non-UUID ticket ID and an empty note → `TypeError`; `health()` → `ok`; an input with extra keys `rawDescription`, `requesterName` (markers, passed with a cast) leaves no marker in anything the connector records or sends. `cleanup` runs after each case for live connectors. Run the suite against `FakeConnector` in `test/fake.contract.test.ts`.
Env: none.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T5.C.01**: `runHelpdeskContract("fake", () => new FakeConnector())` passes, and each of its cases fails against a deliberately broken fake (a fake whose `findByExternalRef` always returns null, one whose `addNote` ignores unknown refs, one that stores the extra marker keys).
- [ ] `failNext("unavailable")` makes the next call throw `HelpdeskError` with `code: "unavailable"` and `retryable: true`; `failNext("auth")` gives `retryable: false`; `setAsleep(true)` makes every call throw `InstanceAsleepError` and `health()` return `asleep`.
- [ ] `HelpdeskError` and `InstanceAsleepError` messages name the operation and the code only: with a marker as the ticket title, no error message or property holds the marker.
- [ ] A non-UUID ticket ID, an empty note and a 5 001-character note each throw `TypeError` with no recorded call.
- [ ] `pnpm --filter @ai-it-support/helpdesk test`, `typecheck`, `lint` and `build` pass, and the root `pnpm test` runs the new package's tests.

## Non-Goals

- ServiceNow (P5-T3a–b). Shadow mode (P5-T4). The built-in connector (§6.3.1 P5-T13).

## How to Test

- `pnpm --filter @ai-it-support/helpdesk test` · `pnpm test`

## Assumptions

- `HelpdeskTicketState` uses the §6.3.1 G3 names. When P5-T9 adds `packages/shared/src/helpdesk-state.ts`, that module may re-export from or replace this type without changing the contract suite.
- Idempotency of creation is the caller's job (`helpdesk-sync` runs `findByExternalRef` before `createTicket`), so the contract does not require a second create to return the first ticket. §6.3.1 P5-T13 adds that check for `BuiltinConnector` only.

---

## P5-T3a — ServiceNow client, typed errors, query encoding and the category map

Risk: normal (lean mode, resolved point 3) · Depends on: **P5-T2**

## Description

Add `packages/helpdesk/src/servicenow/`. `client.ts`: `createServiceNowClient({ instanceUrl, username, password, fetch?, timeoutMs? })` with `get(table, params)`, `post(table, body, fields)` and `patch(table, sysId, body)` on `/api/now/table/<table>`. `Authorization: Basic …`, `Accept: application/json`, a 15-second timeout per request, `redirect: "manual"`. Response mapping: 2xx JSON → `result`; 401 and 403 → `HelpdeskError` `auth`; 404 → `not_found`; 400 → `bad_request`; 429 → `rate_limited`; 5xx, a network error or a timeout → `unavailable`; a 200 that is not JSON → hibernation check, else `bad_response`. Hibernation (`hibernation.ts`): a non-JSON 200 whose HTML holds the hibernation marker from the real sample, or a 3xx whose `Location` host is `developer.servicenow.com`, → `InstanceAsleepError`. A 503 is `unavailable`, never asleep. `query.ts`: `buildParams(fields)` turns a map of field filters into `URLSearchParams` (each value one percent-encoded parameter); `sysparm_query` is never built from data; `sysparm_fields` and `sysparm_limit` come from constants. `isLookupSafeEmail(value)` (resolved point 8). `ticketIdParam(id)` accepts a UUID only; `sysIdParam(id)` accepts `^[0-9a-f]{32}$` only. `mapping.ts`: `toServiceNowCategory(category)` (identity over the 6; unknown → `TypeError`), `toImpactUrgency(priority)`, `toServiceNowState(state)` (resolved point 7). Add `serviceNowEnvShape` to `packages/shared/src/env.ts`: `SERVICENOW_INSTANCE_URL`, `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD` (at least 12 characters), `SERVICENOW_DEFAULT_CALLER`. Save the hibernation sample as `packages/helpdesk/test/fixtures/servicenow-hibernating.html` (no instance secrets in it).
Env: `SERVICENOW_INSTANCE_URL`, `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD`, `SERVICENOW_DEFAULT_CALLER` (new, pipeline; add to `.env.example` with placeholders).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T5.U.01**: `toServiceNowCategory` returns each of `database`, `inquiry`, `software`, `hardware`, `password_reset`, `network` unchanged; `"Hardware"`, `""` and `"other"` throw `TypeError` that does not echo the value. `toImpactUrgency` gives P1 1/1, P2 1/2, P3 2/2, P4 2/3; `toServiceNowState` gives 2, 3 (+ `hold_reason`), 6 and 7 (+ `close_code`, `close_notes`).
- [ ] **T5.U.02**: a lookup for `a^b@x.com`, `x@y.com^ORactive=true`, `x@y.com\r\nX: 1` and `x@y.com,z@y.com` is refused by `isLookupSafeEmail` and sends no request; `ünï@exämple.com` and `demo.carol@example.com` give a request whose only data-bearing parameter is `email=<percent-encoded value>`; no request URL in the test has a `sysparm_query` parameter built from input (recorded URLs).
- [ ] **T5.U.03**: the real hibernation sample → `InstanceAsleepError`; a 302 to `https://developer.servicenow.com/…` → `InstanceAsleepError`; a 503 → `HelpdeskError` `unavailable` (not asleep); a request that does not answer within the timeout → `unavailable` (fake timers); a non-JSON 200 without the marker → `bad_response`. Each error is an `instanceof` the right class with the right `retryable`.
- [ ] 401 and 403 → `auth` with `retryable: false`; 429 → `rate_limited`, retryable; 404 → `not_found`.
- [ ] The `Authorization` header is sent only to the configured instance origin; with the password set to a marker, no error message, error property or logger spy call holds the marker.
- [ ] `ticketIdParam("x' OR 1=1")` and `sysIdParam("../incident")` throw `TypeError` before any request.
- [ ] Env: valid values pass. An `http://` URL, a URL with a path, a host that does not end in `.service-now.com`, an 11-character password and a default caller of 31 characters each fail, naming the variable. The `.env.example` test passes.

## Non-Goals

- Connector methods and the contract run (P5-T3b). Retries (the `helpdesk-sync` task retries, P5-T5a).

## How to Test

- `pnpm --filter @ai-it-support/helpdesk test` · `pnpm --filter @ai-it-support/shared test`

## Assumptions

- ServiceNow's Table API accepts field filters as plain query parameters (`?email=<value>`) next to `sysparm_*` parameters (Table API docs, checked at build). The strict email rule makes the lookup safe even if the instance parsed `^` in a field parameter.
- A sleeping personal developer instance answers with an HTML page or a redirect to the developer portal. The orchestrator saves a real sample the next time `dev420188` hibernates; until then the builder uses the page from ServiceNow's developer documentation and says so in the report.
- The stock priority matrix maps impact/urgency 1/1, 1/2, 2/2 and 2/3 to priorities 1–4 (checked on `dev420188` by the verify script, P5-T7).

---

## P5-T3b — `ServiceNowConnector` and the live contract run

Risk: normal (lean mode, resolved point 3) · Depends on: **P5-T3a, P5-T7, P5-T1c**

## Description

Add `packages/helpdesk/src/servicenow/connector.ts`: `ServiceNowConnector` implements `HelpdeskConnector` on the P5-T3a client. `createTicket`: caller lookup (`sys_user`, `email` + `active=true`, limit 2; resolved point 8), group lookup (`sys_user_group`, `name`, limit 2, cached), then `post("incident", { short_description, description, category, impact, urgency, caller_id, assignment_group, correlation_id, correlation_display: <ticket number> }, "sys_id,number")` (resolved points 7, 23). `CreateHelpdeskTicketInput` gains `ticketNumber`, checked with `ticketNumberSchema` from P5-T1c; returns `{ externalId: sys_id, number, callerDefaulted }`. `findByExternalRef(ticketId)`: `get("incident", { correlation_id })`, limit 2; 0 → null, 1 → the ref, 2 → `HelpdeskError` `duplicate_external_ref`. `addNote(ref, body)`: `patch("incident", sysId, { work_notes: body })`. `updateTicket(ref, { state })`: `patch` with the mapped fields. `health()`: one `get("sys_user", {}, limit 1)`; `ok`, `asleep` on `InstanceAsleepError`, `down` on any other error. Run the P5-T2 contract suite against it with `msw` (`packages/helpdesk/test/servicenow.contract.test.ts`, a small in-memory Table API mock). Add the live scenario `T5.C.02` to `tests/live`: it runs the same suite against `dev420188` with the P5-T7 ServiceNow helper's credentials and `isTest: true`, and closes every incident it created (`cleanup`).
Env: none new (uses the names from P5-T3a; the live scenario uses `E2E_SERVICENOW_*` from P5-T7).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] The P5-T2 contract suite passes for `ServiceNowConnector` against the Table API mock.
- [ ] `createTicket` for a test ticket sends `short_description` starting `[E2E] `, cut to 160 characters, the redacted description, the mapped category, impact and urgency, `correlation_id` = the ticket ID, `correlation_display` = the ticket number (`ITS-…`), and the caller and group sys_ids; the request body holds no key other than those listed; a bad ticket number throws `TypeError` before any request.
- [ ] A requester email with no `sys_user`, with two, or refused by `isLookupSafeEmail` gives `caller_id = SERVICENOW_DEFAULT_CALLER` and `callerDefaulted: true`; exactly one gives that user's sys_id and `callerDefaulted: false`.
- [ ] A group name the instance does not have → `HelpdeskError` `config` and no incident request; the group lookup runs once for two tickets with the same group (cache).
- [ ] `findByExternalRef` with two matching incidents throws `duplicate_external_ref`; with none returns null.
- [ ] With the egress recorder on and the requester email registered with `recorder.forbid`, the email appears only in the `sys_user` lookup URL; with raw title, raw description and requester name as markers (passed with a cast), no request holds a marker.
- [ ] **T5.C.02** (live scenario): against a mock e2e ServiceNow it passes, closes every incident it created (the mock records one close per created incident), and fails when the mock keeps one open. Against `dev420188` it is run by the orchestrator (O4).

## Non-Goals

- The `helpdesk-sync` task (P5-T5a). Auto-fix on `sys_user` (phase 6, optional).

## How to Test

- `pnpm --filter @ai-it-support/helpdesk test` · `pnpm --filter @ai-it-support/live-tests test`

## Assumptions

- The `itil` role can create and update incidents, add work notes and read `sys_user` and `sys_user_group` (stock ServiceNow; the verify script in P5-T7 confirms the reads).
- `correlation_id` is a stock incident field and is filterable through the Table API.

---

## P5-T4 — Shadow-mode wrapper and the `shadowMode` test switch

Risk: normal (lean mode, resolved point 3) · Depends on: **P5-T2**

## Description

Add `packages/helpdesk/src/shadow.ts`: `withShadowMode(connector, { enabled, log })` returns a `HelpdeskConnector`. When `enabled` is false it returns the connector unchanged (same object). When true, `createTicket`, `addNote` and `updateTicket` make no call to the inner connector, log `shadow_skipped` with the operation name, and return `{ skipped: "shadow" }`; `findByExternalRef` and `health` pass through (reads are not writes). `shadowEnabled({ env, overrides })`: true when `SHADOW_MODE` is true, or when the effective test overrides have `shadowMode: true` (resolved point 11). Add `shadowMode: z.literal(true).optional()` to `testOverridesSchema`. List `shadow.ts` in `guard-modules.json` with `statements: 90` and `mutation: 80`.
Env: none new (`SHADOW_MODE` exists).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T5.I.04**: `withShadowMode(new ServiceNowConnector(…), { enabled: true })` against `msw`: `createTicket`, `addNote` and `updateTicket` each return `{ skipped: "shadow" }`, and the recorder sees no POST or PATCH request (a `findByExternalRef` GET is allowed and recorded).
- [ ] With `enabled: false` the wrapper returns the same connector object, and every call reaches it.
- [ ] `shadowEnabled`: `SHADOW_MODE=true` → true whatever the overrides; `SHADOW_MODE=false` with effective overrides `{ shadowMode: true }` → true; with `{}` → false. On staging (`E2E_MODE=false`) a requested `shadowMode` has no effect beyond `SHADOW_MODE` (table test).
- [ ] `testOverridesSchema` rejects `shadowMode: false` and `shadowMode: "true"`.
- [ ] The log line names the operation and holds no ticket text (markers).
- [ ] `shadow.ts` is in `guard-modules.json`; `pnpm test:mutation -- packages/helpdesk/src/shadow.ts` reaches 80 % or more.

## Non-Goals

- The status `incident_skipped_shadow` and the `shadow_skipped` ticket event (written by `helpdesk-sync`, P5-T5a).

## How to Test

- `pnpm --filter @ai-it-support/helpdesk test` · `pnpm --filter @ai-it-support/shared test` · `pnpm test:mutation -- packages/helpdesk/src/shadow.ts`

## Assumptions

- §6.3.1 P5-T14 wraps whichever connector the selector returns with this wrapper, so the built-in helpdesk gets the same protection.

---

## P5-T5a — `helpdesk-sync` task

Risk: normal · Depends on: **P5-T1b, P5-T3b, P5-T4**

## Description

Add the Trigger.dev task `helpdesk-sync` in `services/pipeline/src/trigger/helpdesk-sync.ts` (a `schemaTask`; `HELPDESK_SYNC_TASK_ID` in `packages/shared`); the body `runHelpdeskSync(payload, deps, attempt)` is exported for tests. The sync guard `services/pipeline/src/helpdesk/sync-guard.ts` (pure, guard module): `checkSync(status)` → `run` for `auto`, `approved` and `helpdesk_pending`; `done` for `incident_created` and `incident_skipped_shadow`; `refuse` for every other status. Steps: load the ticket and triage; guard (`refuse` → event `sync_refused { status }`, `alert:sync_refused`, return `{ refused: true }` with no connector call; `done` → `{ skipped: true }`); `setTicketStatus("helpdesk_pending")` and `helpdesk_sync_started` unless already there; build the connector (`ServiceNowConnector` wrapped by `withShadowMode`, and by the asleep switch wrapper when `helpdeskAsleepMinutes` applies); `findByExternalRef(ticketId)` → when found, use it; else `createTicket` with the redaction, triage category, priority, group, the ticket number and the requester email. A `ShadowSkip` → event `shadow_skipped { operation: "create" }`, status `incident_skipped_shadow`, done. Else store the ref with `setTicketIncident(ticketId, { sysId, number })` (new repository function: compare-and-set `where servicenow_sys_id is null`; a different stored sys_id → `HelpdeskError` `conflict`), event `caller_defaulted` when flagged, event `incident_created { externalId, number }`, the triage work note (resolved point 6) and `helpdesk_note_added`, then status `incident_created`. Each event is written once across retries. Errors: `InstanceAsleepError` → the asleep wait loop (resolved point 9); `auth` → `helpdesk_sync_failed`, status `failed`, `alert:helpdesk_auth_failed`, no retry; `config` and `bad_request` → `failed`, `alert:helpdesk_config`, no retry; `unavailable` and `rate_limited` → throw (task retries: 3 attempts, exponential backoff); the task's `onFailure` → `helpdesk_sync_failed`, status `failed` unless already final, `alert:helpdesk_sync_failed`, never throws. `createHelpdeskSyncDeps(env)` validates `serviceNowEnvShape` at task start. Add `helpdeskAsleepMinutes` to `testOverridesSchema` (1–30).
Env: none new (uses P5-T3a names and `SHADOW_MODE`).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T5.I.01**: on the local REST stack with ServiceNow mocked by `msw`, an `auto` ticket ends `incident_created` with `servicenow_sys_id` and `servicenow_number` stored; its events after `auto` are `helpdesk_sync_started`, `incident_created`, `helpdesk_note_added`; the mock received one incident POST and one work-note PATCH.
- [ ] **T5.I.02**: the mock creates the incident but the response is lost (the request times out); the retry's `findByExternalRef` finds it by `correlation_id`; the mock holds one incident, and `incident_created` is written once.
- [ ] **T5.I.03**: ServiceNow 401 and 403 → status `failed`, `helpdesk_sync_failed { error: "auth" }`, one `alert:helpdesk_auth_failed` row, and no retry; 500 and a timeout → retried, and after 3 attempts `onFailure` sets `failed` with `alert:helpdesk_sync_failed`; a 500 then 200 → `incident_created` on the second attempt.
- [ ] **T5.I.05**: a forged trigger for a `rejected` ticket → `sync_refused { status: "rejected" }`, `alert:sync_refused`, no ServiceNow request, status unchanged; the same for `escalated_manual`, `review_pending`, `triaged` and `failed` (table test).
- [ ] An `InstanceAsleepError` on the first two tries and `ok` on the third: `helpdesk_asleep` events with attempts 1 and 2, waits of 1 and 2 minutes (fake `wait.for`), status `helpdesk_pending` in between, then `incident_created`. Asleep for more than 6 hours (fake clock) → `helpdesk_sync_failed { error: "asleep" }`, `failed`, one `alert:helpdesk_asleep_timeout`.
- [ ] `helpdeskAsleepMinutes: 3` on an e2e test ticket makes the connector asleep until 3 minutes after `created_at`, then real calls go through; with `is_test = false` or `E2E_MODE=false` it has no effect. Values `0`, `31` and `"3"` are rejected by the schema.
- [ ] Shadow (`SHADOW_MODE=true`, or the `shadowMode` switch on an e2e test ticket): status `incident_skipped_shadow`, event `shadow_skipped { operation: "create" }`, no POST or PATCH.
- [ ] `setTicketIncident` twice with the same sys_id → `changed: false` the second time; with another sys_id → `HelpdeskError` `conflict` and nothing changes.
- [ ] No event payload, log line or ServiceNow request body holds the raw title, raw description, requester name or (outside the `sys_user` lookup) the requester email (markers, egress recorder).
- [ ] **T5.S.03**: `sync-guard.ts` and `shadow.ts` are in `guard-modules.json` with `statements: 90` and `mutation: 80`; `pnpm test:mutation -- services/pipeline/src/helpdesk/sync-guard.ts packages/helpdesk/src/shadow.ts` reaches 80 % or more on each.

## Non-Goals

- Starting the task from `triage-ticket` and `review-ticket` (P5-T5b). The reply email (P5-T8b). Choosing the connector by `HELPDESK` (§6.3.1 P5-T14).

## How to Test

- `pnpm --filter @ai-it-support/pipeline test` · `pnpm test:integration` · `pnpm test:mutation -- services/pipeline/src/helpdesk/sync-guard.ts`

## Assumptions

- Trigger.dev docs (checked for phase 4): `wait.for` inside a task is checkpointed and does not count as compute time; a retried attempt re-runs the body, so every step before a write is idempotent.
- The status model allows `auto` → `helpdesk_pending`, `approved` → `helpdesk_pending` and `helpdesk_pending` → `incident_created` | `incident_skipped_shadow` (plan §2.6, `packages/shared/src/status.ts`).

---

## P5-T5b — Sync triggers, the ticket view `incident`, and the local runner

Risk: normal · Depends on: **P5-T5a**

## Description

Resolved point 5. `runTriageTicket`: after `setTicketStatus("triaged")` with the route `auto`, set `auto` and call `deps.triggerHelpdeskSync({ ticketId, testOverrides }, { idempotencyKey: "helpdesk-sync:<ticketId>" })`. Crash recovery as P4-T4c: a ticket already `auto` triggers again with the same key and returns `{ skipped: true }`. `runReviewTicket`: after `approved`, the same trigger. A failed trigger in either place: event `helpdesk_enqueue_failed { error }`, status `failed`, `alert:helpdesk_sync_failed`, and the run throws `AbortTaskRunError` naming the ticket ID. `rejected` and `escalated_manual` trigger nothing. The internal ticket view gains `incident: { number, sysId } | null` from `tickets.servicenow_number` and `servicenow_sys_id` (both set or neither). Update the live-suite mock (`tests/live/src/testing/mock-e2e.ts`). Extend `services/pipeline/test-support/local-runner.ts` so it runs `helpdesk-sync` with ServiceNow answered by its `msw` handlers (needed by §6.3.1 T5.E.03). Add `servicenow` (`SERVICENOW_INSTANCE_URL`, `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD`, `SERVICENOW_DEFAULT_CALLER`) to the `healthcheck` task's `configured` map.
Env: none new.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] An `auto` triage result: status `auto`, then `triggerHelpdeskSync` once with `{ ticketId }`, the payload's `testOverrides` unchanged and the key `helpdesk-sync:<ticketId>`. A `review` route triggers no sync.
- [ ] `review-ticket`: `approve` → `triggerHelpdeskSync` once after the status `approved`; `reject` and timeout → no call (asserted for phase 4 DoD 3, "no helpdesk step is ever scheduled").
- [ ] A trigger that throws → `helpdesk_enqueue_failed { error: <class name> }`, status `failed`, one alert, `AbortTaskRunError` with the ticket ID.
- [ ] A ticket already `auto` → the trigger is called again with the same key, no AI call, `{ skipped: true }`.
- [ ] The view of an `incident_created` ticket has `incident: { number, sysId }`; a ticket without one has `incident: null`; the strict schema rejects an `incident` with an extra key; the existing view and T3.S.03 tests pass.
- [ ] Local runner: an `auto` test ticket reaches `incident_created` with the ServiceNow mock, with the network off.
- [ ] The `healthcheck` result has `configured.servicenow`, true only when all four names are set; the existing healthcheck tests pass with only the expected-keys list changed.

## Non-Goals

- Live scenarios (P5-T5c). The email trigger (P5-T8b).

## How to Test

- `pnpm --filter @ai-it-support/pipeline test` · `pnpm --filter web test` · `pnpm --filter @ai-it-support/live-tests test` · `pnpm build && pnpm test:e2e`

## Assumptions

- Trigger.dev docs (checked for phase 3): an `idempotencyKey` on a trigger returns the first run instead of starting a second one.

---

## P5-T5c — Live scenarios: incidents, approve/reject/timeout, shadow and asleep

Risk: normal · Depends on: **P5-T5b, P5-T7, P5-T3b**

## Description

Test code only, in `tests/live`. Each scenario is tested against the mock e2e app and a mock ServiceNow, and uses the P5-T7 ServiceNow helper to read incidents by `correlation_id` and to close the `[E2E]` incidents it created when it ends. Shared step `createHelpdeskTicket(context, scenarioId, { persona, text, testOverrides? })` → `POST /api/internal/test-tickets` (`testId` = `<runId>:<scenarioId>:<n>`). The runner context keeps a list of the tickets the run created. Scenarios (resolved points 18–19): `T5.L.01`: printer fault as `demo.carol` → `incident_created` within 60 s of `createdAt` (`incident_created` event time); exactly one incident by `correlation_id`; category `hardware`; `caller_id` = `demo.carol`'s sys_id; `short_description` starts `[E2E]`; `correlation_display` equals the view's `number`; one work note (DoD 5). `T5.L.03`: the same `testId` sent twice → one ticket ID, one incident. `T5.L.04`: three HR tickets from `demo.erin`: A signed approve (P4-T6 helper) → one incident within 60 s of `approved`; B signed reject and C left to the 2-minute timeout → 0 incidents, checked 60 s after `rejected` / `escalated_manual`. `T5.L.05`: `testOverrides: { shadowMode: true }` → `incident_skipped_shadow`, a `shadow_skipped` event, 0 incidents. `T5.L.02` (heavy): the 10 eval tickets labelled `auto` (requesters `e2e-load+<n>@example.com`), at most 4 at a time → p95 of (`incident_created` − `createdAt`) < 60 s; the evidence lists the 10 values. `T5.L.08` (heavy, after `T5.L.02` in the same run, else `not_run`): for those 10, the incident's `assignment_group` is the sys_id of the triage group. `T5.F.01` (heavy): `testOverrides: { helpdeskAsleepMinutes: 3 }` → at least one `helpdesk_asleep` event, status `helpdesk_pending` while asleep, then `incident_created` within 10 minutes and one incident. `T5.O.01` (runs last): every ticket of this run with an `incident_created` event has exactly one incident whose `correlation_id` is the ticket ID, and every `[E2E]` incident created since the run start has such a ticket (100 %).
Env: none new (uses `E2E_SERVICENOW_*` from P5-T7 and the phase 4 Slack signer names).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] `T5.L.01` passes against the mocks. It fails, naming the check, when the incident comes after 61 s (fake clock), when the category is `software`, when the caller is the default caller, when there are two incidents, and when the work note is missing.
- [ ] `T5.L.03` passes with one incident and fails with two.
- [ ] `T5.L.04` passes for 1 / 0 / 0 incidents and fails when the rejected or the timed-out ticket gets one.
- [ ] `T5.L.05` passes for 0 incidents and `incident_skipped_shadow`, and fails when the mock creates one.
- [ ] `T5.L.02` passes when 9 of 10 latencies are under 60 s and fails at a p95 of 61 s; it never has more than 4 ticket creations in flight (the mock records the peak). `T5.L.08` fails, naming the ticket, when one group differs.
- [ ] `T5.F.01` passes when the mock reports asleep for 3 minutes and then creates one incident; it fails when no `helpdesk_asleep` event is written and when the ticket is not `incident_created` at the limit (shortened in the test).
- [ ] `T5.O.01` fails when an incident has no matching ticket and when a ticket has two incidents.
- [ ] Every scenario closes the incidents it created (the mock records one close each); the helper refuses to close one whose `short_description` lacks `[E2E]`.
- [ ] `--phase 5` selects `T5.C.02`, `T5.L.01`, `T5.L.03`, `T5.L.04`, `T5.L.05`, `T5.O.01` (and the P5-T8c scenarios) but not `T5.L.02`, `T5.L.08`, `T5.F.01`; across the default scenarios of this part the mock sees 6 `test-tickets` requests and 0 form submits.
- [ ] Each scenario's evidence has ticket IDs, incident numbers, times in ms and the sum of `aiCallCount`; no ticket text.

## Non-Goals

- The reply email checks (P5-T8c). The built-in live scenarios (§6.3.1 P5-T22).

## How to Test

- `pnpm --filter @ai-it-support/live-tests test`

## Assumptions

- On e2e `SLACK_REVIEW_TIMEOUT` is `2m` (H14) and `SHADOW_MODE` is `false` (H16, resolved point 12).
- The 10 eval tickets labelled `auto` route `auto` live; phase 3's eval results support this (resolved point 18).

---

## P5-T6 — `helpdesk-health` scheduled task and the health flags

Risk: normal · Depends on: **P5-T3b**

## Description

Add `services/pipeline/src/trigger/helpdesk-health.ts`: a `schedules.task` with the cron `*/30 * * * *`, body `runHelpdeskHealth(deps)` exported for tests. It builds the connector (P5-T5a deps) and calls `health()` once; output `{ connector: "servicenow", status, checkedAt }`. `asleep` → `alert:helpdesk_asleep`; `down` → `alert:helpdesk_down` (each aggregated per minute, phase 3 resolved point 7); a health call that throws counts as `down`. The run never fails. In the web app, `getHelpdeskHealth()` in `apps/web/src/lib/health/helpdesk.ts` reads the latest completed `helpdesk-health` run and its output through `@trigger.dev/sdk` (`runs.list` with the task identifier and `COMPLETED`, limit 1), caches the result 60 seconds, and returns `{ reachable, asleep }` (resolved point 10). `healthConfigSchema.features` gains `helpdeskReachable` and `helpdeskAsleep`; `GET /api/health/config` reports them. A failure to read the run gives `false` for both and logs the error class name.
Env: none new.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] `runHelpdeskHealth` with the connector answering `ok` → output `status: "ok"`, no alert; with the real hibernation sample (P5-T3a fixture) through `msw` → `asleep` and one `alert:helpdesk_asleep`; with a 503 → `down` and one `alert:helpdesk_down`; with `health()` throwing → `down`, and the run resolves.
- [ ] The exported task options have the cron `*/30 * * * *`.
- [ ] `getHelpdeskHealth`: a run 10 minutes old with `ok` → `{ reachable: true, asleep: false }`; 46 minutes old → `reachable: false`; `asleep` → `{ reachable: false, asleep: true }`; no run → both false; the SDK throwing → both false and a log line with the class name only.
- [ ] Two calls within 60 seconds make one SDK request (fake clock); a third after 61 seconds makes another.
- [ ] `GET /api/health/config` has both booleans; `healthConfigSchema` stays strict and boolean-only (T3.S.03 passes); no ServiceNow host, number or error text is in the response.

## Non-Goals

- Pausing intake while the instance sleeps (tickets wait in `helpdesk-sync`, P5-T5a). §6.3.1 P5-T14's change that makes this task report the selected connector.

## How to Test

- `pnpm --filter @ai-it-support/pipeline test` · `pnpm --filter web test`

## Assumptions

- Trigger.dev SDK 4.6.4 offers `runs.list` filtered by task identifier and status, and its list items or `runs.retrieve` carry the run output (checked at build; if the output needs `runs.retrieve`, that is one more request per cache miss).
- A schedule declared in code is registered on deploy for both Trigger.dev projects (Trigger.dev docs, checked at build).

---

## P5-T7 — Persona seed script, verify script and the live ServiceNow helper

Risk: normal · Depends on: nothing

## Description

Plan P5-T7 and §4.2. Add `scripts/servicenow/seed-personas.js`: an idempotent ServiceNow background script (ES5, Rhino) that Seun runs on `dev420188` (H16). It creates or updates the 7 `demo.*` users of §4.2 (`demo.alice`, `demo.bob`, `demo.carol`, `demo.dave`, `demo.erin`, `demo.frank`, `demo.gina`): first and last name, email `demo.<name>@example.com` (or `REPLY_MAILBOX` for `demo.carol` when that variable at the top of the script is set; resolved point 13), `active` (`false` only for `demo.gina`), `locked_out = false`, and exactly the §4.2 roles (`snc_internal`; `demo.frank` also `itil`): it adds missing roles and removes others, for `demo.*` users only. It never touches a user whose `user_name` does not start with `demo.` (`abel.tuter` stays stock), sets no password, and prints one line per user (`created` / `updated` / `unchanged`). Add `scripts/` to the repo-layout allow-list. Add `tests/live/src/servicenow.ts`: `createE2eServiceNow(config, fetch)` with `E2E_SERVICENOW_INSTANCE_URL` (must be exactly `https://dev420188.service-now.com`), `E2E_SERVICENOW_USERNAME`, `E2E_SERVICENOW_PASSWORD`; GET methods `incidentsByCorrelationId(ticketId)` (fields `sys_id`, `number`, `category`, `caller_id`, `assignment_group`, `short_description`, `description`, `state`), `workNotes(sysId)` (`sys_journal_field`, element `work_notes`), `userByName(name)`, `userRoles(sysId)`, `groupByName(name)`, `incidentCategories()` (`sys_choice`, `incident` / `category`); one write, `closeIncident(sysId)`, which re-reads the incident and refuses unless `short_description` starts with `[E2E]`. Add `liveServiceNowEnvShape`; a scenario that needs a missing name reports `not_run`. Add the verify command `pnpm --filter @ai-it-support/live-tests verify:personas` (read-only): each persona exists with its exact roles and `active` value, `abel.tuter` exists, the 6 categories and the 6 assignment groups exist, and (if readable) `svc.itsupport` has only `itil`; it exits non-zero naming each missing item.
Env: `E2E_SERVICENOW_INSTANCE_URL`, `E2E_SERVICENOW_USERNAME`, `E2E_SERVICENOW_PASSWORD` (new, live tests only; add to `.env.example`).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] Run in `node:vm` with a fake `GlideRecord`, `gs` and role tables: the first run creates 7 users with the §4.2 roles and active values; a second run changes nothing and prints `unchanged` 7 times; a `demo.alice` with an extra `admin` role loses it; `abel.tuter` is never written; with `REPLY_MAILBOX` set only `demo.carol`'s email changes.
- [ ] A static test fails if any `insert()`, `update()` or `deleteRecord()` in the script is reachable for a user name that does not start with `demo.`; the script sets no password field.
- [ ] `verify:personas` against a mock instance with everything present exits 0; it exits non-zero and names the item when a persona is missing, when `demo.frank` lacks `itil`, when `demo.gina` is active, when a category is missing and when a group is missing.
- [ ] The helper refuses any instance URL other than `https://dev420188.service-now.com` before any request; `closeIncident` on an incident without `[E2E]` is refused after the re-read and sends no PATCH; no method other than `closeIncident` sends a non-GET request.
- [ ] With the password set to a marker, no stdout, stderr, report or error holds the marker.
- [ ] `liveServiceNowEnvShape`: a bad URL fails, naming the variable; with the names unset a scenario that needs them is `not_run` (exit code 2).

## Non-Goals

- Running the script on `dev420188` (Seun, H16). Seeding auto-fix state (`locked_out = true` for tests; phase 6, optional).

## How to Test

- `pnpm --filter @ai-it-support/live-tests test` · `pnpm --filter @ai-it-support/shared test`

## Assumptions

- Background scripts run as the admin who starts them (Seun), so the script may create users and roles; the integration user `svc.itsupport` never needs those rights.
- `itil` can read `sys_user`, `sys_user_has_role`, `sys_user_group`, `sys_choice` and `sys_journal_field` on a stock instance; a read the role cannot do is reported as `not_checked`, not as a pass.

---

## P5-T8a — Reply email template and Resend client

Risk: normal · Depends on: nothing

## Description

Add `services/pipeline/src/email/`. `template.ts`: `buildReplyEmail({ kind, ticketNumber, number, fixSteps, isTest })` → `{ subject, text, html }`. `incident_reply`: subject `Your IT ticket <ticketNumber>` (`[E2E] ` prefix for test tickets); body: a fixed greeting, `Your ticket number is <ticketNumber>.`, `Helpdesk reference: <number>.`, the fix steps numbered (at most 8, each passed through `redact` again; resolved point 16), a fixed closing. `needs_info`: subject `More detail needed for your IT ticket <ticketNumber>`; body: `Your ticket number is <ticketNumber>.` and the fixed checklist (resolved point 15); no helpdesk number. `ticketNumber` must pass `ticketNumberSchema` (P5-T1c), else `TypeError`. Nothing else: no ticket text, no name, no link. `number` must match `^(INC[0-9]{7,}|HD[0-9]{7})$`, else `TypeError`. HTML is built from fixed markup with every step HTML-escaped. `headers.ts`: `assertHeaderSafe(value, name)` refuses CR, LF and NUL; `parseRecipient(email)` accepts one lower-case-normalised address matching a strict rule; `isAllowedRecipient(email, list)` is an exact match on the normalised address. `resend.ts`: `createResendClient({ apiKey, fetch?, sleep?, timeoutMs? })` with `send({ from, to, subject, text, html, idempotencyKey })` → `{ id }`: one POST to `https://api.resend.com/emails` with `Authorization: Bearer`, `Idempotency-Key`, a 10-second timeout; 429 (`Retry-After` up to 30 s) and 5xx, a network error or a timeout are retried inside the call (3 requests; 1 s, then 2 s); other 4xx and a reply without `id` throw `EmailProviderError` with a code. Add `replyEnvShape`: `RESEND_API_KEY`, `REPLY_FROM`, `REPLY_ALLOWED_RECIPIENTS` (names above).
Env: `RESEND_API_KEY`, `REPLY_FROM`, `REPLY_ALLOWED_RECIPIENTS` (new, pipeline; add to `.env.example` with placeholders).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] **T5.U.04**: a recipient, `REPLY_FROM` or fix step holding `\r\nBcc: x@y.com` cannot reach a header: `parseRecipient` and `assertHeaderSafe` throw `EmailHeaderError` naming the field, before any request; a number `INC0010001\r\nX: 1` throws `TypeError`. A step `<script>alert(1)</script>` appears as `&lt;script&gt;…` in `html` and unchanged in `text`.
- [ ] An `incident_reply` for `ITS-000042` and `INC0010001` with 3 steps gives the subject `Your IT ticket ITS-000042` (`[E2E] Your IT ticket ITS-000042` for a test ticket), both numbers in both bodies and the 3 steps numbered; a ticket number `ITS-42` or `ITS-000042\r\n` throws `TypeError`; 10 steps show the first 8. A step holding a canary from `canaries.ts` is redacted in both bodies.
- [ ] `needs_info` gives the subject `More detail needed for your IT ticket ITS-000042`, the checklist and no helpdesk number; the same input gives a deep-equal result twice (pure).
- [ ] Given extra input keys `requesterName`, `rawDescription` with markers (cast), no output holds a marker.
- [ ] `isAllowedRecipient("Carol@Example.com", ["carol@example.com"])` is true; `carol@example.com.evil`, `x+carol@example.com` and `carol@example.co` are false.
- [ ] Resend client: 200 `{ id }` → one request with the URL, headers (including `Idempotency-Key`) and JSON body; 429 with `Retry-After: 2` then 200 → 2 requests and a sleep of 2 000 ms; three 500s → `EmailProviderError` `http_500` after 3 requests; 422 → `EmailProviderError` `http_422` after 1 request; no `id` → `bad_response`.
- [ ] With the API key and a body as markers, no error message, error property or logger spy call holds a marker.
- [ ] Env: valid values pass; a key without `re_`, a `REPLY_FROM` with two addresses, an upper-case or duplicate recipient, 21 recipients and an empty list each fail, naming the variable. The `.env.example` test passes.

## Non-Goals

- The task, the `notifications` rows and the triggers (P5-T8b). Inbound email (phase 8, optional).

## How to Test

- `pnpm --filter @ai-it-support/pipeline test` · `pnpm --filter @ai-it-support/shared test`

## Assumptions

- Resend's send API accepts an `Idempotency-Key` header and returns the first result for a repeated key within 24 hours (Resend docs, checked at build).
- The incident number is not personal data, so it may appear in the subject.

---

## P5-T8b — `notify-requester` task, `notifications` rows, the ticket view and the health flag

Risk: normal · Depends on: **P5-T8a, P5-T1b, P5-T1c, P5-T5b**

## Description

Add to `packages/db`: `notificationSchema` and `recordNotification({ ticketId, channel, kind, status, providerId, reason })` → `{ created, notification }` (on `23505` it returns the stored row with `created: false`), `getNotification(ticketId, kind)`, and `getRequesterEmail(ticketId)` (service role, pipeline only; named column only). Add the Trigger.dev task `notify-requester` (`services/pipeline/src/trigger/notify-requester.ts`, `NOTIFY_REQUESTER_TASK_ID`), body `runNotifyRequester(payload, deps)`. Steps: an existing row for `(ticketId, email, kind)` → done; `incident_reply` needs status `incident_created` and a stored number, else `AbortTaskRunError`; read the requester email; not allowed by `REPLY_ALLOWED_RECIPIENTS` → row `skipped` (`not_allow_listed`) and `notification_skipped`, no Resend request; else `buildReplyEmail` (with the stored `ticket_number`) and `send` with the key `notify:<ticketId>:<kind>`, then row `sent` with `provider_id` and `notification_sent`. Task retries: 3 attempts; `onFailure` → row `failed` (`provider_error`), `notification_failed`, `alert:notify_failed`, never throws; the ticket status never changes. Triggers (resolved points 15–16): `helpdesk-sync` after `incident_created` (not after shadow) starts `notify-requester { kind: "incident_reply" }`; `review-ticket` after `review_requested` starts `{ kind: "needs_info" }` when the triage flags hold `needs_info`; a failed trigger → `notify_enqueue_failed`, `alert:notify_enqueue_failed`, and the run goes on. The internal view's `notifications` becomes a strict list of `{ id, channel, kind, status, reason, providerId, at }`, oldest first. `probeSchema` and `healthConfigSchema.features` gain `migration0006` (a select on `notifications.id`). Add `resend` (`RESEND_API_KEY`, `REPLY_FROM`, `REPLY_ALLOWED_RECIPIENTS`) to the `healthcheck` task's `configured` map. Update the live-suite mock.
Env: none new.
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] An `incident_created` ticket with an allow-listed requester: one Resend request with the template output (subject holds the ticket's `ITS-` number) and the key `notify:<id>:incident_reply`, one `sent` row with the provider ID, one `notification_sent` event. Running the task again sends nothing.
- [ ] A requester not on the list: no Resend request, one `skipped` row (`not_allow_listed`), one `notification_skipped` event.
- [ ] **T5.I.06**: Resend answers 429 then 200 → `sent` after 2 requests. Resend always answers 500 → 3 attempts, then `onFailure`: one `failed` row, `notification_failed`, one `alert:notify_failed` row with `count = 1`; the ticket stays `incident_created`.
- [ ] `helpdesk-sync` starts `notify-requester` once after `incident_created` and never after `incident_skipped_shadow`; `review-ticket` starts the `needs_info` variant once for a `needs_info` ticket and not for others; a trigger that throws leaves the ticket's status as it was and raises one alert.
- [ ] An `incident_reply` for a ticket that is `rejected`, or has no number, → `AbortTaskRunError` and no request.
- [ ] Integration (local REST stack, 0001–0006): the whole flow writes the rows above; a second `recordNotification` for the same `(ticket, channel, kind)` returns `created: false`.
- [ ] The view lists the notification with all seven keys; a view entry with an unknown key fails the schema. `GET /api/health/config` reports `migration0006: true` when every probe passes, and `false` with status 200 when only the `notifications` probe fails.
- [ ] The egress recorder: the requester email appears only in Resend's `to`; no event, row or log line holds it or any ticket text (markers).
- [ ] `configured.resend` is true only when all three names are set; the existing healthcheck tests pass with only the expected-keys list changed.

## Non-Goals

- Live email checks (P5-T8c). Email for built-in staff actions.

## How to Test

- `pnpm --filter @ai-it-support/pipeline test` · `pnpm --filter @ai-it-support/db test` · `pnpm --filter web test` · `pnpm test:integration`

## Assumptions

- The integration tests run on the stack from P5-T1b.
- A ticket that is approved after a `needs_info` email later gets its `incident_reply` too; that is two emails of two kinds, one each (resolved point 2).

---

## P5-T8c — Live scenarios: reply email, canaries and the log scan

Risk: normal · Depends on: **P5-T8b, P5-T5c**

## Description

Test code only, in `tests/live`. Add `tests/live/src/resend.ts`: `createE2eResend(config, fetch)` with `E2E_RESEND_READ_KEY`; one method, `getEmail(id)` → `{ lastEvent, to, subject, html, text }` (GET `https://api.resend.com/emails/<id>`); it never sends another method. Add `liveResendEnvShape` (`E2E_RESEND_READ_KEY`, `E2E_REPLY_RECIPIENT`). Scenarios, each tested against the mocks, reusing the P5-T5c steps (resolved points 13, 18): `T5.L.06`: the printer fault as `demo.carol` (requester `E2E_REPLY_RECIPIENT`) plus `canaryTicketText(runId)`; if it reaches `review_pending`, a signed approve; then the view shows a `sent` `incident_reply` with a provider ID; `getEmail` shows `lastEvent = delivered` within 120 s; the ticket number (`number`) from the view is in the subject, and it and the incident number are in both bodies; `findCanaries` over subject, text and html finds 0; judge J1 on the steps and J4 on the text each score 0.7 or more. `T5.L.07`: a vague ticket (`it's broken, please fix`) from `demo.carol` → triage flags hold `needs_info`, status `review_pending`, a `sent` `needs_info` notification whose email subject is the details variant; then a signed reject (so the ticket does not wait). `T5.S.01`: requester `canary+<runId>@example.com`, text with `canaryTicketText(runId)`; approve if it goes to review; then 0 canaries in the incident's fields and work notes (ServiceNow helper), the notification is `skipped` (`not_allow_listed`), and judge J3 on the incident description scores 0.5 or less. `T5.S.02`: `pnpm scan:logs` over the phase's run window (Dokploy and Trigger.dev logs) with patterns added here: `Authorization: Basic`, a Resend key (`re_[A-Za-z0-9_]{20,}`), and the ServiceNow password value taken from the env at scan time (matched, never printed); 0 hits.
Env: `E2E_RESEND_READ_KEY`, `E2E_REPLY_RECIPIENT` (new, live tests only; add to `.env.example`).
New dependency: none.
Target repo: D:/Homebase/Sandbox/ai-it-support-agent

## Acceptance Criteria

- [ ] `T5.L.06` passes against the mocks. It fails, naming the check, when the email is not `delivered` at the limit (shortened), when the number is missing, when a canary is in the html, and when J1 or J4 scores 0.69.
- [ ] `T5.L.07` passes when the details variant is sent and fails when the notification kind is `incident_reply` or missing.
- [ ] `T5.S.01` passes against the mocks and fails when the mock incident's description or a work note holds a canary, when the notification is `sent`, and when J3 scores 0.51.
- [ ] `T5.S.02` passes on a clean log fixture and fails on fixtures holding each new pattern; the password value is in no output or report.
- [ ] The Resend helper sends only GET (the mock records methods); with the read key set to a marker, the marker is in no output, report or error.
- [ ] The three ticket scenarios create 3 tickets and make 3 judge calls in total; the evidence has IDs, statuses, times and judge scores only.

## Non-Goals

- Fixing the app when a scenario fails on e2e (a fix task, plan §2.2 step 7).

## How to Test

- `pnpm --filter @ai-it-support/live-tests test`

## Assumptions

- Resend's `GET /emails/{id}` returns `last_event` and the sent content with a full-access key (Resend docs, checked at build); a sending-only key cannot read (resolved point 14).
- Judges J1, J3 and J4 are the calibrated phase 3 judges (P3-T11d endpoints).

---

## Amendments to §6.3.1 bundles (ticket numbers, 2026-11-07)

These add to the filed bundle descriptions; everything else in §6.3.1 stays as written.

- **P5-B4 (P5-T11a), high-risk:** the column-level `select` grant to `authenticated` on `tickets` also includes `ticket_number` (display only; not raw text, so G8 allows it). Extra criterion: a JWT for an active staff user reads `ticket_number`; a non-staff JWT reads 0 rows. P5-B6's exact privilege allow-list then includes this grant with no other change.
- **P5-B10 (P5-T17):** the list's first column is the ticket number (`ITS-…`), next to the helpdesk number (`HD…`); rows still link by the ticket UUID (`/staff/tickets/<uuid>`). Extra criterion: each row shows its seeded `ITS-` number, and every row link holds the UUID, never the number. Depends also on P5-T1c.
- **P5-B11 (P5-T18):** the ticket page header shows `Ticket ITS-000042` above the redacted title; the URL stays `/staff/tickets/[id]` with the UUID, and `/staff/tickets/ITS-000042` is a 404 like any non-UUID (T5.S.07 rule). Extra criterion: the seeded number is in the header; the number in the URL gives 404.

---

## Orchestrator steps (not filed)

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                          | When                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| O1  | Seun approves this spec; file the 16 parts in ClickUp list `Build Loop` (start statuses as in the order table, HELD comments on the blocked ones; "HELD, G2" ones name P5-B6); update the HELD comments of P5-B1 (waits for P5-T1a and P5-T1b), P5-B7 (waits for P5-T2, P5-T3a–b, P5-T4, P5-T5a–b) and P5-B10 (also P5-T1c); move P5-B8 to `blocked` (HELD, G2); add the amendment text to P5-B4, P5-B10 and P5-B11           | Before building                                    |
| O2  | After P5-B6 merges, ask Seun for H28b once (0006, 0007 and 0008 each pre-tested up → down → up on `supabase/postgres:17.6.1.177`); release the G2-held parts at the same time and keep building; deploy nothing that reads the new objects to e2e until Seun confirms H28b                                                                                                                                                    | After P5-B6                                        |
| O3  | Preflight (plan §2.2 step 1): `GET /api/health/config` on the e2e app shows `migration0006` and `helpdeskReachable` true; a `healthcheck` run on the E2E project shows `configured.servicenow` and `configured.resend` true; `pnpm --filter @ai-it-support/live-tests verify:personas` exits 0; read `GET /api/internal/usage` for the month before every live run                                                            | After the setup checklist, H28b and the e2e deploy |
| O4  | Verify: `pnpm test:live --phase 5` twice in a row; `pnpm test:live --only T5.L.02,T5.L.08,T5.O.01` (DoD 1, at least 10 tickets); `pnpm test:live --only T5.F.01`; `pnpm scan:logs` and `pnpm scan:traces` on the phase's runs (T5.S.02); T5.R.01 by hand (previous Dokploy build and pipeline commit redeployed, health checked, rolled forward), then `--only T5.L.01`; Stryker judged by CI (`pnpm test:mutation -- --all`) | After O3                                           |
| O5  | Goal check on e2e (plan §6.3): submit the printer fault as `demo.carol`; see the incident on `dev420188` (category `hardware`, caller `demo.carol`); receive the reply email at the allow-listed address with the incident number                                                                                                                                                                                             | After O4                                           |
| O6  | Built-in part (§6.3.1): after P5-B15 and H31, run its live scenarios and record the built-in goal check and Seun's UAT. Then `docs/evidence/phase-5.md`, PROJECT §6/§11 lines, and the release PR with the `high-risk` list (P5-T1a, P5-T1b and the 7 high-risk bundles)                                                                                                                                                      | After O5 and P5-B15                                |

## Human steps (not filed)

| #    | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Who                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| H16  | On `dev420188`: create the integration user `svc.itsupport` with role `itil` only; run `scripts/servicenow/seed-personas.js` (P5-T7) as a background script, with `REPLY_MAILBOX` set to the mailbox used in H17. Env per plan §5: `SERVICENOW_PASSWORD` (store `ITSUPPORT_SERVICENOW_PASSWORD`), `SERVICENOW_INSTANCE_URL`, `SERVICENOW_USERNAME`, `HELPDESK=servicenow`, `SHADOW_MODE` (E2E project `false`, main project `true` until the release; resolved point 12), `SERVICENOW_DEFAULT_CALLER`, on the main `prod` and E2E Trigger.dev projects. For live tests, the approved loader maps the same user to `E2E_SERVICENOW_*` (resolved point 14) | You (Claude runs the verify script, O3)                  |
| H17  | Resend: verify the sending domain; API key; senders `help@`, `e2e-sender@`. Env: `RESEND_API_KEY` (store `ITSUPPORT_RESEND_API_KEY`), `REPLY_FROM` (`help@<project domain>`), `REPLY_ALLOWED_RECIPIENTS` (your mailbox from H16) on the main `prod` and E2E projects. Added by this spec: a second, full-access key for tests only, `ITSUPPORT_E2E_RESEND_READ_KEY` → `E2E_RESEND_READ_KEY`, and `E2E_REPLY_RECIPIENT` (the same mailbox) for the live tests (resolved point 14)                                                                                                                                                                         | You                                                      |
| H28b | Replaces H18, H28 and H29 (G2, resolved point 24). After P5-B6 merges, in one Supabase Studio sitting, in this order: apply `supabase/migrations/0006_itsupport_helpdesk.sql` (paste the file unedited: its check compares the function body; if it fails with 55P03 (lock timeout), wait and re-run it, nothing was applied), then `supabase/migrations/0007_itsupport_builtin_helpdesk.sql`, then `supabase/migrations/0008_itsupport_staff_access.sql`; then run `supabase/checks/0006_itsupport_helpdesk.check.sql`, `supabase/checks/0007_itsupport_builtin_helpdesk.check.sql` and `supabase/checks/0008_itsupport_staff_access.check.sql`. Every row must show `ok = true`. If one file fails, stop and tell the orchestrator; do not run the next one                                            | You (Claude pre-tests all three on a throwaway database) |
| H25  | Merge the `dev` → `main` release PR after reading the `high-risk` test files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | You                                                      |
| H26  | As in §6.3.1: Supabase Auth on the shared stack: tell the loop the GoTrue version (for the local harness); add `https://<staging-host>/staff` and `https://<e2e-host>/staff` to the auth redirect allow-list; confirm invite email (SMTP) works, or create staff users in Studio with a set password instead. Disabling sign-up for the whole stack is optional and affects other apps (G7). GoTrue version on the shared stack: v2.189.0 (read from /auth/v1/health, 2026-11-06)                                                                                                                                                                        | You                                                      |
| H27  | As in §6.3.1: `SUPABASE_ANON_KEY` (store `ITSUPPORT_SUPABASE_ANON_KEY`) on the staging and e2e apps; `HELPDESK` (`servicenow` or `builtin`) on both apps and both Trigger.dev projects                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | You                                                      |
| H30  | Can wait until UAT. As in §6.3.1: invite the first admin in Supabase Auth, then run `supabase/scripts/grant-staff.sql` with that email and role `admin`; repeat for each staff member                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | You                                                      |
| H31  | Can wait until UAT. As in §6.3.1: set `HELPDESK=builtin` on the E2E project and the e2e app and redeploy; UAT on e2e (sign in, open a ticket, add a note, assign, change state, approve one waiting review, sign out); Claude confirms the events through §2.5. Set `HELPDESK` back afterwards if wanted                                                                                                                                                                                                                                                                                                                                                 | You                                                      |

## Seun setup — one sitting (G2)

Do these in one go, before the migration sitting (H28b). Only the persona script (ServiceNow step 6) may come later, because its code is built after the migrations. Each step says where to click and what to name things. You put secret values only in your key store; the orchestrator copies them to the apps with `push_env.py` and never sees or prints them. Settings that are not secret, you just tell the orchestrator in chat.

**1. ServiceNow (H16), on `https://dev420188.service-now.com`, signed in as admin**

1. Open **User Administration → Users → New**. User ID `svc.itsupport`, first name `IT Support`, last name `Agent`. Tick **Web service access only**. Save.
2. On that user, set a password (**Set Password**), then add the role **itil** (Roles tab → Edit → `itil` → Save). No other role.
3. Copy that user's sys_id (right-click the form header → **Copy sys_id**). Tell the orchestrator: "default caller sys_id is …". It becomes `SERVICENOW_DEFAULT_CALLER` (not secret).
4. Key store: add `ITSUPPORT_SERVICENOW_PASSWORD` = the password from step 2. That is the only ServiceNow secret.
5. Tell the orchestrator (not secret): instance URL `https://dev420188.service-now.com`, user name `svc.itsupport`, and the mailbox where you want to receive the test reply emails.
6. Later, when the orchestrator says P5-T7 has merged (it is held until the migrations are built, so this one step may come after the sitting): open `scripts/servicenow/seed-personas.js` from the repo and set `REPLY_MAILBOX` at the top to the mailbox from step 5. Then open **System Definition → Scripts - Background**, paste the whole script and click **Run script**. You should see 7 lines, one per `demo.*` user (`created`, `updated` or `unchanged`). Running it again is safe.

**2. Resend (H17), on resend.com**

1. **Domains → Add domain**: your project domain. Add the DNS records Resend shows, then wait until it says **Verified**.
2. **API Keys → Create**: name `itsupport-send`, permission **Sending access**, domain = that domain. Key store: `ITSUPPORT_RESEND_API_KEY`.
3. **API Keys → Create** a second one: name `itsupport-e2e-read`, permission **Full access** (tests only read with it). Key store: `ITSUPPORT_E2E_RESEND_READ_KEY`.
4. Senders need no setup in Resend beyond the verified domain. The app sends from `help@<your domain>`; `e2e-sender@<your domain>` is for the optional email-intake phase.
5. Tell the orchestrator (not secret): the domain, and that the allowed reply recipient is the mailbox from ServiceNow step 5.

**3. Supabase Auth (H26 part 2), in Supabase Studio for the shared stack**

1. **Authentication → URL Configuration → Redirect URLs → Add URL**: `https://<staging-host>/staff`, then `https://<e2e-host>/staff` (the two app hosts, exactly as in plan §6.3.1 H26).
2. Invite email: decide **on** or **off**, and tell the orchestrator which.
   - On: **Authentication → Emails** must have working SMTP; send yourself a test invite.
   - Off: you will create staff users in Studio with a set password at UAT time instead.
3. Do not turn off sign-up for the whole stack: other apps use it, and this app does not need it (G7).

**4. Key-store names the orchestrator will push (H27)**

You only add values to your key store. The orchestrator runs `push_env.py` and checks each name; it never reads the values.

| Key-store name                  | Becomes               | Pushed to                                                                                |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------- |
| `ITSUPPORT_SERVICENOW_PASSWORD` | `SERVICENOW_PASSWORD` | main Trigger.dev `prod`, E2E Trigger.dev project; e2e tests as `E2E_SERVICENOW_PASSWORD` |
| `ITSUPPORT_RESEND_API_KEY`      | `RESEND_API_KEY`      | main Trigger.dev `prod`, E2E Trigger.dev project                                         |
| `ITSUPPORT_E2E_RESEND_READ_KEY` | `E2E_RESEND_READ_KEY` | e2e tests only                                                                           |
| `ITSUPPORT_SUPABASE_ANON_KEY`   | `SUPABASE_ANON_KEY`   | staging app, e2e app (needed for the staff login)                                        |

The orchestrator sets the non-secret values itself, from what you told it: `SERVICENOW_INSTANCE_URL`, `SERVICENOW_USERNAME`, `SERVICENOW_DEFAULT_CALLER`, `SHADOW_MODE` (`false` on E2E, `true` on main), `HELPDESK=servicenow` (both apps, both Trigger.dev projects), `REPLY_FROM`, `REPLY_ALLOWED_RECIPIENTS`, `E2E_REPLY_RECIPIENT`.

**5. Then the migration sitting (H28b)**, when the orchestrator says P5-B6 has merged: the H28b row above.

**Can wait until UAT:** H30 (invite the first admin and run `grant-staff.sql`) and H31 (switch e2e to `HELPDESK=builtin`, then the staff UAT). H25 (merge the release PR) comes at the end.

## Coverage matrix: test ID → task

Every phase 5 test ID has exactly one owner. T5.U.05, T5.U.06, T5.I.09 and T5.S.07 were added on 2026-11-07 for ticket numbers; the plan's test table does not list them. "Orchestrator verify" means the orchestrator runs the owner's script on the e2e environment in step O4 (or O6 for the built-in IDs). IDs owned by P5-T9–P5-T22 are specified in plan §6.3.1 and listed here only for completeness.

| Test ID | Owner  | Runs                                                          |
| ------- | ------ | ------------------------------------------------------------- |
| T5.U.01 | P5-T3a | Local + CI                                                    |
| T5.U.02 | P5-T3a | Local + CI                                                    |
| T5.U.03 | P5-T3a | Local + CI                                                    |
| T5.U.04 | P5-T8a | Local + CI                                                    |
| T5.U.05 | P5-T1d | Local + CI (added 2026-11-07: number on Slack cards)          |
| T5.U.06 | P5-T1c | Local + CI (added 2026-11-07: number format)                  |
| T5.C.01 | P5-T2  | Local + CI                                                    |
| T5.C.02 | P5-T3b | Orchestrator verify (O4), live on `dev420188`                 |
| T5.C.03 | P5-T13 | Local + CI (§6.3.1)                                           |
| T5.I.01 | P5-T5a | Local + CI                                                    |
| T5.I.02 | P5-T5a | Local + CI                                                    |
| T5.I.03 | P5-T5a | Local + CI                                                    |
| T5.I.04 | P5-T4  | Local + CI                                                    |
| T5.I.05 | P5-T5a | Local + CI                                                    |
| T5.I.06 | P5-T8b | Local + CI                                                    |
| T5.I.07 | P5-T1b | Local + CI                                                    |
| T5.I.08 | P5-T20 | Local + CI (§6.3.1)                                           |
| T5.I.09 | P5-T1b | Local + CI (added 2026-11-07: number backfill)                |
| T5.E.01 | P5-T21 | Local + CI (§6.3.1)                                           |
| T5.E.02 | P5-T21 | Local + CI (§6.3.1)                                           |
| T5.E.03 | P5-T21 | Local + CI (§6.3.1; uses the P5-T5b local runner)             |
| T5.L.01 | P5-T5c | Orchestrator verify (O4)                                      |
| T5.L.02 | P5-T5c | Orchestrator verify (O4), heavy                               |
| T5.L.03 | P5-T5c | Orchestrator verify (O4)                                      |
| T5.L.04 | P5-T5c | Orchestrator verify (O4)                                      |
| T5.L.05 | P5-T5c | Orchestrator verify (O4)                                      |
| T5.L.06 | P5-T8c | Orchestrator verify (O4)                                      |
| T5.L.07 | P5-T8c | Orchestrator verify (O4)                                      |
| T5.L.08 | P5-T5c | Orchestrator verify (O4), heavy                               |
| T5.L.09 | P5-T22 | Orchestrator verify (O6, §6.3.1)                              |
| T5.L.10 | P5-T22 | Orchestrator verify (O6, §6.3.1)                              |
| T5.L.11 | P5-T22 | Orchestrator verify (O6, §6.3.1)                              |
| T5.S.01 | P5-T8c | Orchestrator verify (O4)                                      |
| T5.S.02 | P5-T8c | Orchestrator verify (O4), `pnpm scan:logs`                    |
| T5.S.03 | P5-T5a | Local + CI; gate judged by CI (`pnpm test:mutation -- --all`) |
| T5.S.04 | P5-T21 | Local + CI (§6.3.1)                                           |
| T5.S.05 | P5-T21 | Local + CI (§6.3.1)                                           |
| T5.S.06 | P5-T22 | Orchestrator verify (O6, §6.3.1)                              |
| T5.S.07 | P5-T1c | Local + CI (added 2026-11-07: number is display only)         |
| T5.X.01 | P5-T21 | Local + CI (§6.3.1)                                           |
| T5.F.01 | P5-T5c | Orchestrator verify (O4), heavy                               |
| T5.O.01 | P5-T5c | Orchestrator verify (O4)                                      |
| T5.R.01 | P5-T5c | Orchestrator verify (O4): rollback by hand, then `T5.L.01`    |

## Coverage matrix: Definition of Done → proof

Phase 5 DoD (plan §6.3):

| DoD   | Item                                                                             | How it is proven                                                                                 |
| ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1     | Auto route → incident, p95 < 60 s over ≥ 10 live tickets                         | T5.L.02 (P5-T5c, 10 tickets); T5.L.01                                                            |
| 2     | Category in the 6; the persona's caller                                          | T5.L.01 (P5-T5c); T5.U.01 (P5-T3a); categories and personas checked by `verify:personas` (P5-T7) |
| 3     | Duplicate submit → 1 incident by `correlation_id`                                | T5.L.03 (P5-T5c); T5.I.02 (P5-T5a)                                                               |
| 4     | Approve → 1; Reject → 0; timeout → 0                                             | T5.L.04 (P5-T5c); T5.I.05 (P5-T5a); the review-ticket trigger tests (P5-T5b)                     |
| 5     | The update path adds a work note                                                 | T5.L.01 work-note check (P5-T5c); T5.I.01 (P5-T5a); resolved point 6                             |
| 6     | Shadow mode: 0 incidents, `shadow_skipped`, `incident_skipped_shadow`            | T5.L.05 (P5-T5c); T5.I.04 (P5-T4); P5-T5a shadow criterion                                       |
| 7     | Instance asleep: `asleep`, the ticket waits and completes                        | T5.F.01 (P5-T5c); T5.U.03 (P5-T3a); P5-T6 health tests; resolved points 9–10                     |
| 8     | Contract suite: `FakeConnector`, and live for `ServiceNowConnector`              | T5.C.01 (P5-T2); T5.C.02 (P5-T3b)                                                                |
| 9     | Email delivered to an allow-listed address; others skipped; `needs_info` variant | T5.L.06, T5.L.07, T5.S.01 skipped check (P5-T8c); T5.I.06 (P5-T8b)                               |
| 10    | 0 canaries in incident fields, work notes and email bodies                       | T5.S.01, T5.L.06 (P5-T8c); egress recorder (P5-T3b, P5-T5a, P5-T8b)                              |
| 11–17 | Built-in helpdesk additions                                                      | Plan §6.3.1 (T5.C.03, T5.E.01–03, T5.S.04, T5.I.08, T5.X.01, H31)                                |

Universal DoD (plan §3):

| DoD | Item                                           | How it is proven                                                                                                                                                   |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Tasks done, merged, reviewed                   | ClickUp and PR list; two reviews for each `high-risk` row in the order table                                                                                       |
| 2   | PROJECT §9 gates, coverage floors              | CI on the final `dev` commit; per-module floors for the new guard modules (`shadow.ts`, `sync-guard.ts`, and §6.3.1's three)                                       |
| 3   | Mutation score ≥ 80 % on guards                | `pnpm test:mutation -- --all` judged by CI; T5.S.03                                                                                                                |
| 4   | Semgrep: no unaccepted high finding            | `semgrep` job (unchanged)                                                                                                                                          |
| 5   | Migration up, down, tested, applied            | T5.I.07, T5.I.09 (P5-T1b); H28b (0006, 0007, 0008 in one sitting); `migration0006: true` (P5-T8b)                                                                  |
| 6   | `dev` deployed to e2e; `.env.example` complete | `pnpm deploy:pipeline` with the E2E ref; Dokploy deploy; `/api/health` 200; `configured.servicenow`, `configured.resend` (P5-T5b, P5-T8b); the `.env.example` test |
| 7   | Live suite green twice in a row                | `pnpm test:live --phase 5` twice (O4); heavy scenarios separately                                                                                                  |
| 8   | Rollback rehearsed on e2e                      | T5.R.01 by hand, then `pnpm test:live --only T5.L.01`                                                                                                              |
| 9   | No PII canary in external sinks                | T5.S.01, T5.L.06 (ServiceNow, Resend); egress recorder; `pnpm scan:traces` and `pnpm scan:logs` (T5.S.02)                                                          |
| 10  | Goal check                                     | O5 (and O6 for the built-in part)                                                                                                                                  |
| 11  | Evidence file                                  | `docs/evidence/phase-5.md` with the reports from `.loop-evidence/`, incident numbers, and the TypeSafe and LLM call counts of the phase                            |
| 12  | PROJECT §6/§11 updated, release PR             | Orchestrator; §11 lines for resolved points 1, 3, 9, 10, 12, 14 and 24 (the ticket-number line, points 20–23, is in PROJECT §11 2026-11-07)                        |

## ClickUp impact (2026-11-07 amendment)

The 16 parts are not filed yet, so they are filed from this version. Already filed, and now different from this spec:

- P5-B1: "Depends on P5-T1" now means P5-T1a and P5-T1b.
- P5-B2 and P5-B6: their "loop pauses for H28 / H29 after the merge" lines are replaced by the single H28b after P5-B6.
- P5-B4: extra `ticket_number` column grant and criterion (amendments section).
- P5-B7: depends on the code parts P5-T2, P5-T3a–b, P5-T4, P5-T5a–b.
- P5-B8: moves from `backlog` to `blocked` (HELD, G2).
- P5-B10 and P5-B11: extra number column / header and criteria (amendments section); P5-B10 also waits for P5-T1c.
- P5-B15: depends on H26–H27, H28b, H30, H31 (H28 and H29 are now H28b).
