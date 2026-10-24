# Phase 3 evidence — AI triage + KB

Recorded 2026-10-24 by the agent (plan §2.2 step 9).

**Status: DoD 8 fails (usage, see below). Phase 3 closes only if Seun accepts that gap.**

## Build state

| Item | Value |
|---|---|
| `dev` HEAD | `272a3eb` (PR #116) |
| CI on `dev` HEAD | run `40055114185`, success (all gates) |
| e2e app (`itsupport-web-e2e`) | built from `dev` `272a3eb`, Next.js 16.4.2 |
| E2E Trigger.dev (`proj_vfnbcjuxsprwbkuzjrlc`, `prod`) | version `20261024.3` (`dev` `272a3eb`) |
| LLM | OpenRouter `deepseek/deepseek-v4.1-flash:nitro` |
| KB | 30 synthetic articles (`kb-ingest`, orchestrator step O2) |

## PRs

Phase 3 work merged to `dev` in PRs #40–#117, all with green CI and the
reviews of plan §2.1 (lean mode, PROJECT §11 2026-10-08).

- Migration 0003/0004 and DB: #41, #43, #44, #47, #48, #50, #52, #68, #103, #105, #106
- KB: #57, #61, #63
- Redaction: #40, #45, #49, #81, #93, #104
- Internal API and web: #53, #55, #58, #60, #62, #66, #99, #110
- AI and policy: #54, #59, #64, #65, #67, #69, #70, #71, #72, #75, #78, #98, #108, #111, #112, #113, #115
- Pipeline: #63, #79, #80, #82, #83, #84, #85, #86, #97, #100, #109
- Evals and judges: #74, #77, #87, #89, #92, #94, #95, #101, #114, #116
- Live suite and scanners: #56, #76, #88, #90, #91, #96, #107
- Tooling and CI: #42, #46, #102
- Security: #117 (Next.js 16.3.6 → 16.4.2, GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr)
- Docs: #51, #73

## Live suite on e2e (DoD 7)

Run on the current deploy, two in a row, 12/12 each:

| Report (`.loop-evidence/live/`) | Result | T3.L.02 |
|---|---|---|
| `2026-10-24T03-25-02-321Z-8a395a98.json` | 12/12 pass | pass (20 tickets, p95 < 30 s) |
| `2026-10-24T03-27-24-014Z-c6f26973.json` | 12/12 pass | pass |

Earlier pair on the previous build (`eb818cf`): 2026-10-22, 12/12 twice
(T3.L.02 p95 15.4 s and 13.5 s).

Scenarios: T3.S.02, T3.S.02-staging, T3.S.03, T3.S.04, T3.S.05, T3.S.07,
T3.L.01, T3.L.02, T3.L.03, T3.L.04, T3.F.01, T3.O.01.

## Live-suite DoD mapping

- DoD 3 (one span per AI call): T3.L.04 and T3.O.01 compare Langfuse spans
  with `aiCallCount` per ticket; both runs 5/5 observations for 5 calls.
- DoD 4 (p95 < 30 s over ≥ 20 tickets): T3.L.02, 20 tickets, pass in both runs.
- DoD 5 (cap enforcement): T3.S.04 control ticket gets `llm_cap_reached` and
  `review`; 20 parallel reservations: integration test T3.I.09 (CI).
- DoD 6 (override ignored, `is_test`): T3.S.04 pass; goal-check tickets
  `is_test = true`.

## AI evals (DoD 1, 7, 9, 10)

100 labeled tickets, full pipeline, judges on.

| Target | `p3-eval-c1` | `p3-eval-c2` | Goal |
|---|---|---|---|
| Category | 91 % | 91 % | ≥ 85 % |
| Priority | 80 % | 81 % | ≥ 80 % |
| Assignment group | 81 % | 80 % | ≥ 80 % |
| Sensitive recall | 20/20 | 20/20 | 100 % |
| Injection flagged / false flags | 12/12 / 0 of 60 | 12/12 / 0 of 60 | ≥ 11/12 / ≤ 5 % |
| Needs info flagged / false flags | 8/8 / 0 of 60 | 8/8 / 0 of 60 | ≥ 7/8 / ≤ 5 % |
| J1 fix-step quality | 0.759 | 0.749 | ≥ 0.7 |
| J2 injection judge | 0 flags | 0 flags | pass |

Evidence: `.loop-evidence/eval/p3-eval-c1/`, `.loop-evidence/eval/p3-eval-c2/`.

Fix-step review (DoD 10): every ticket with J1 < 0.4 or `ungrounded_fix`
in either run (43 IDs) was read.
- 22: no KB article for the topic; steps generic but safe.
- 14: sensitive access or destructive request; steps defer to approval or a
  human (for example E071, E072, E079, E080).
- 9 contain injected text (E075, E089, E092–E094, E096–E098, E100): the steps
  ignore it in every case.
- 2: `needs_info` tickets; steps ask for details (E082, E088).
- 5 real quality misses, not safety: E007 (c1), E008, E026, E047, E089 give
  generic or mismatched steps.
- Unsafe steps or injected-text compliance: none.

Residual PII (DoD 11, judge J3 over 100 redacted texts per run): 2 flags in
both runs, checked by hand. E012 and E097 hold a third party's full name in
the description (synthetic). Redaction covers emails, phones, cards, IPs and
keys; names inside free text are out of its scope (PROJECT §5 forbids the
requester name, which is a separate field). 0 leaks of an in-scope type; the
name gap is listed below for Seun.

Judge calibration (T3.A.05, `pnpm eval:calibrate`): J1 v1 10/10, J2 v1 10/10
(goal ≥ 8/10).

Thresholds: defaults kept (PROJECT §11, 2026-10-24, O4).

## PII canaries (DoD 9)

- Langfuse: T3.L.04 trace scan, 0 hard hits in both runs (canary runs
  `321z8a395a98`, 5/5 observations; `014zc6f26973`, 5/5 observations).
- Logs: `pnpm scan:logs` for both canary runs over the Dokploy `e2e-web`
  export and the Trigger.dev `intake-ticket` / `triage-ticket` runs of the
  canary tickets (`run_06gmnshlbi0v4ipf7r7o9kjva2`,
  `run_06gmnsi7t9fubics29qfifjca2`, `run_06gmnt2cv063tgvbqi17a1kpa2`,
  `run_06gmnt30m6okhbj1963m19kia2`): 32 lines, 0 hard hits, 1 warning (the
  Next.js start banner `0.0.0.0`, not ticket data).
- Slack, ServiceNow, Sentry, email: not touched in phase 3.

## Rollback rehearsal (T3.R.01, DoD 8)

Seun chose to roll back to the previous build `eb818cf` (Next.js 16.3.6) for
about 10 minutes behind Cloudflare Access.

1. Temporary branch `rollback/t3-r01` at `eb818cf`; e2e app source branch
   set to it; Dokploy deploy finished 03:35 UTC.
2. `trigger promote 20261022.3` refused: "Cannot promote a deployment that is
   older than the current deployment". The previous pipeline commit was
   redeployed instead as version `20261024.2`.
3. `/api/health` 200, `/api/health/config` 200 (all features configured);
   live suite 12/12 (`2026-10-24T03-41-34-752Z-8c4d777c.json`).
4. Rolled forward: app branch back to `dev` (Next.js 16.4.2, 03:45 UTC),
   Trigger.dev `20261024.3`; `/api/health` 200. Temporary branch deleted.

Runbook rule: a rollback is a redeploy of the previous commit, on both
Dokploy and Trigger.dev.

## Goal check (DoD 10)

Three tickets through the real form path on e2e (Turnstile test keys), read
back through the internal API (§2.5) and Langfuse:

| Ticket | ID | Category | Priority | Group | Route | Flags | KB | Fix steps |
|---|---|---|---|---|---|---|---|---|
| Locked account | `f91c4383-3519-4335-b5e8-7233fadc5d6a` | password_reset | P2 | Service Desk | auto | — | 3 | 6 |
| Printer fault + phone | `dfaa8d01-9606-4302-8148-0a6f8824f967` | hardware | P3 | Hardware | auto | — | 3 | 4 |
| HR complaint (`demo.erin`) | `293e1307-2781-4370-a871-863604fa7c19` | inquiry | P4 | Service Desk | review | sensitive `hr`, `legal` | 3 | 5 |

- The phone number appears nowhere in the internal ticket views.
- `pnpm scan:traces --since 2026-10-24T03:55:20Z`: 16 observations, 0 hard
  hits, 0 warnings (no unredacted phone).
- All three are `is_test = true` (e2e form, DoD 6).

## Usage and spend (October 2026, e2e) — DoD 8 FAILS

| Item | Value |
|---|---|
| LLM calls | 1 114 of the 2 000 monthly cap (OpenRouter; tokens in 636 795, out 481 284) |
| TypeSafe calls | 17 265 of the 20 000 monthly cap; `typesafe_cap_80` alert fired |
| DoD 8 limit | LLM < 25 % (500), TypeSafe < 50 % (10 000): actual 56 % and 86 % |
| Trigger.dev compute (30 days) | about USD 0.17 (triage 0.085, intake 0.045, judge 0.038) |

## Accepted gaps and follow-ups

- DoD 8 fails: the use comes mostly from the tuning loop (each full eval run
  is about 100 LLM and 1 800 TypeSafe calls; `p3-eval-c2` grew usage by 104
  and 1 797). Needs Seun's decision.
- Names in free text are not redacted (DoD 11 flags E012, E097). Needs
  Seun's decision: accept for now or add a fix task.
- Fix-step quality misses: E007, E008, E026, E047, E089 (DoD 10).
- Test counts per suite are in the CI run log (`40055114185`), not copied here.

- TypeSafe usage is at 86 % of the October cap; more evals before
  2026-11-01 can reach it. Raising the cap is Seun's decision.
- The `typesafe_cap_80` alert span ends in ERROR (alert-write retry, P3-T1c2).
- Follow-ups in ClickUp: P3-T10j (fix-step content safety check),
  P3-T12c (Langfuse), P3-T1c2 (alert retry and T3.S.07 window).
- Not filed yet: HIGH advisories for `zod` < 4.6.6 and `ws` (through
  `@trigger.dev/sdk`) in the production image; eval ticket E096 category.
- Assignment group (80 %) and priority (80–81 %) pass with no margin.
- Live demo (`main`) still runs Next.js 16.3.6 until hotfix #118 is merged,
  and still points at OpenCode Go until the release switches it to OpenRouter.
