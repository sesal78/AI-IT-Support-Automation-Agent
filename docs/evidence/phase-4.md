# Phase 4 evidence — Slack review

Recorded 2026-11-06 by the agent (spec `docs/specs/2026-10-25-phase-4-slack-review.md`, step O5).
All times are AEDT (Melbourne). Report IDs are UTC stamps, so the clock time differs.

**Status: verified on e2e.** Release pending Seun. T4.S.04 (staging) runs
after the release, because staging is still on phase 3.

## Build state

| Item | Value |
|---|---|
| `dev` HEAD before this PR | `52afbcb` |
| Deployed for the verify | `06941e3` (e2e app and E2E Trigger.dev `20261105.1`, Fri 6 Nov about 7:48 AM) |
| `/api/health` | 200 |
| `/api/health/config` | all true, including `slackInteractivity` |
| Migration 0005 | applied by Seun (H15), Mon 26 Oct about 6 PM; check query all `ok` |
| Slack app | done 24 Oct (H14) |

## PRs

All phase 4 bundles merged to `dev`.

- Migration and DB: #122 (T1a), #125 (T1b)
- Slack guards: #124 (T3a), #126 (T3b)
- Slack package: #127 (T2a)
- Bundles: #129 (B2), #130 (B6), #131 (B1), #132 (B3), #134 (B4), #136 (B5), #137 (B7), #138 (B8)
- Fixes: #139 (P4-F1: decision limit 5 s to 15 s, Slack entity decode in T4.S.02, J4 input without the canary filler), #140 (T4.L.05 waits for `review_requested`)
- CI: #133 (mutation timeout 120 min)

## Env (Fri 6 Nov)

Pushed with `push_env.py`; every name verified ok. No values are recorded here.

| Target | Names set |
|---|---|
| e2e app | `SLACK_SIGNING_SECRET` (test secret), `SLACK_REVIEWER_IDS`, `SLACK_CHANNEL_ID` |
| E2E Trigger.dev | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_REVIEW_TIMEOUT=2m` |
| Staging app | `SLACK_SIGNING_SECRET` (real), reviewer ID, channel ID |
| Main Trigger.dev | `SLACK_BOT_TOKEN`, channel ID, `SLACK_REVIEW_TIMEOUT=24h` |

## Live suite on e2e (universal DoD 7)

`pnpm test:live --phase 4`: 9 scenarios (T4.L.01–L.04, T4.S.01–S.04, T4.S.06).

| Run | Report (`.loop-evidence/live/`) | Time | Result | Note |
|---|---|---|---|---|
| 1 | `2026-11-05T20-49-04-014Z-417b3b31` | Fri 7:49 AM | 3 pass, 6 fail | Causes below |
| 2 | `2026-11-06T00-56-09-077Z-2c67b3d3` | Fri 11:56 AM | 8/9 | Only T4.S.04 failed |
| 3 | `2026-11-06T01-42-25-542Z-0a24b650` | Fri 12:42 PM | 8/9 | Only T4.S.04 failed |

Run 1 causes:
- The decision resume took about 7 s against a 5 s limit.
- Slack returns `plain_text` entity-encoded.
- J4 judged the canary filler.
- T4.S.04 got 404 from staging (staging was still on phase 3).

Runs 2 and 3 count as two green runs in a row, with T4.S.04 waiting for the
release. Run 2 values: T4.L.01 J4 0.798; T4.L.02 decided in 6 742 ms;
T4.L.03 decided in 7 251 ms.

## T4.L.05 (heavy, 20 sensitive tickets)

| Run | Report | Time | Cards | Latency |
|---|---|---|---|---|
| 1 | `2026-11-06T01-07-00-089Z-76ad7e7d` | Fri 12:07 PM | 20/20 | Max 7 153 ms, measured afterwards (test bug, fixed in #140) |
| 2 | `2026-11-06T01-48-23-382Z-91eb4a38` | Fri 12:48 PM | 20/20 | 20/20 times, p95 4 916 ms |

- Run 2 had one outlier: 70 583 ms, ticket `188e75e2`. Its review-ticket run
  `run_06gqt2r5lvmfhav4kthitr6oa2` was QUEUED for 66 s (Trigger.dev
  concurrency under a 20-ticket burst).
- `aiCallCount`: 102 (run 1) and 108 (run 2).
- Seun decided on 2026-11-06 (option A): DoD 1 is judged by p95; the burst
  outlier is a known limit.

## Deploy and rollback (T4.F.01, DoD 8): PASS

- Start Fri 12:25 PM, ticket `df4a1878`, `reviewTimeout` 30m.
- Deployed `dev` `9c4aab9` as E2E Trigger.dev `20261106.1`.
- Rolled back by redeploying `06941e3` as `20261106.2`.
- Finish: approved in 12.9 s (report `2026-11-06T01-30-35-254Z-0f3485fe`, Fri 12:30 PM).

## Rollback rehearsal (T4.R.01, universal DoD 8): PASS

By hand, Fri 6 Nov.

1. 1:33 PM: temporary branch `rollback/t4-r01` made at `272a3eb` (phase 3 e2e code); the e2e app was switched to it.
2. Dokploy deployment `7OKI7Hh7iuhCGM7XbQr-A` finished 1:35 PM. `/api/health` 200; config showed no `slackInteractivity` flag, which confirms the old code.
3. 1:39 PM: rolled forward to branch `dev`. `/api/health` 200; config all true, including `slackInteractivity`.
4. `--only T4.L.02` passed (report `2026-11-06T02-42-24-975Z-b63dd5c9`). Temporary branch deleted.
5. The Trigger.dev side is T4.F.01 (`20261106.1` → `20261106.2`).

## PII canaries (universal DoD 9): PASS

- `pnpm scan:traces --since 2026-11-05T20:45:00Z` for runs `417b3b31`, `2c67b3d3`, `0a24b650`: 327 observations on 4 pages, 0 hard hits, 0 warnings.
- `pnpm scan:logs` on the e2e app container logs (last 6 h, 24 lines) for the same 3 runs: 0 hard hits, 1 warning (`unredacted:IPV4` on the Next.js start banner `0.0.0.0:3000`; phase 3 had the same).
- Trigger.dev runs for canary ticket `6089ae05` inspected: intake `run_06gqt1c38c8puj1hlfa1qrb9a2`, triage `run_06gqt1cvc8b8ekk1oau2fo26a2`, review `run_06gqt1f9ke3jng1a6ibspnf1a2`, judge `run_06gqt1g2qc3unukha6kvmd2ia`. Payloads, outputs and traces hold IDs, route and reasons only.
- Slack history scan in T4.L.01: 0 canaries.

## Goal check (universal DoD 10): PASS

- T4.L.02: a synthetic HR complaint got a card in `#itsupport-e2e`, a signed approve, then `approved` (run 2: 6 742 ms; run 3: pass).
- T4.L.03: a second HR complaint was rejected, ended `rejected`, and had no further event within 30 s (run 2: 7 251 ms).

## Phase 4 DoD (spec coverage matrix)

| DoD | Item | Status | Evidence |
|---|---|---|---|
| 1 | Card within 10 s of `policy_decided` | pass with decision | T4.L.05 run 2: 20/20 times, p95 4 916 ms. One burst outlier, 70 583 ms (queued 66 s). Judged by p95 (Seun, 2026-11-06). |
| 2 | Card text redacted only; 0 canaries in `#itsupport-e2e` | pass | T4.L.01 passed in runs 2 and 3; J4 0.798 in run 2. J4 threshold: see open points. |
| 3 | Approve resumes within 15 s; Reject → `rejected`, no helpdesk step | pass with decision | T4.L.02 decided in 6 742 ms; T4.L.03 in 7 251 ms (run 2). Limit moved from 5 s to 15 s (Seun, 2026-11-06, option A). |
| 4 | Timeout → `escalated_manual`, thread note, no incident | pass | T4.L.04 passed in runs 2 and 3 (2m timeout on e2e). |
| 5 | Bad signature, stale, non-allow-listed → 401 / 401 / 403; replay is a no-op | pass | T4.S.01 passed in runs 2 and 3. |
| 6 | A second click changes nothing | pass | Live replay in T4.S.01, runs 2 and 3. |
| 7 | 20 sensitive tickets → 20 cards | pass | T4.L.05 runs 1 and 2: 20/20 cards. |
| 8 | A waiting run survives a deploy and a rollback | pass | T4.F.01, above. |

T4.S.04 (staging) is pending release.

## Universal DoD

| DoD | Item | Status | Evidence |
|---|---|---|---|
| 1 | Tasks done, merged, reviewed | pass | PR list above. |
| 2 | PROJECT §9 gates, coverage floors | pass | CI on `dev`, green on #138–#140. |
| 3 | Mutation score ≥ 80 % on guards | pass | CI `mutation` job (Stryker on the guard modules) green on #138–#140 (timeout 120 min, #133). |
| 4 | Semgrep: no unaccepted high finding | pass | CI `semgrep` job green on #135, #138, #139 and #140. No accepted-risk entries added in phase 4. |
| 5 | Migration up, down, tested, applied | pass | T4.I.07 (CI); H15 applied 26 Oct; `migration0005` true in `/api/health/config`. |
| 6 | `dev` deployed to e2e; `.env.example` complete | pass | Deploy from `06941e3`; `/api/health` 200; config all true. |
| 7 | Live suite green twice in a row | pass with decision | Runs 2 and 3, 8/9 each; T4.S.04 waits for the release. T4.L.05 and T4.F.01 passed separately. |
| 8 | Rollback rehearsed on e2e | pass | T4.R.01, below. |
| 9 | No PII canary in external sinks | pass | Traces, logs, Trigger.dev runs and the Slack history scan, below. |
| 10 | Goal check | pass | T4.L.02 (approve) and T4.L.03 (reject), below. |
| 11 | Evidence file | pass | This file. November usage so far: LLM 76 of 2 000 (3.8 %), TypeSafe 1 119 of 20 000 (5.6 %); both inside the 25 % and 50 % limits. |
| 12 | PROJECT §6/§11 updated | partial | §11 lines added with this PR. §6 stays `pending` until the release. |

## Open points

- Judge J4 has no calibration set (only J1 and J2 have one). The 0.7
  threshold is unchecked. Open for Seun.
- T4.S.04 runs on staging after the release.
- DoD 1 burst limit: 20 tickets at once can queue a review run for over a
  minute (Trigger.dev concurrency). Accepted.
