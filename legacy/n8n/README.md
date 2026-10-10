# Legacy n8n workflows (live snapshot)

These are the last live versions from `n8n.example.com`, exported on 2026-09-27 before the rebuild.
All 3 workflows were **deactivated** in n8n on the same day. Nothing was deleted.

| File | n8n workflow ID | Nodes | Note |
|---|---|---|---|
| `01-main-it-support-agent.live.json` | `ZGeE0jfZtPHk1j6Q` | 43 | Newer than `workflows/01-main-it-support-agent.json` |
| `02-kb-loader-v2.live.json` | `4K4nyGvb6cTl0jei` | 12 | Was never in this repo before |
| `03-error-handler.live.json` | `WVbA0fr4CaOgzig8` | 8 | Not linked to Main (no `errorWorkflow` setting) |

These files are for reference only. Do not re-activate them. The main workflow sends unredacted ticket text to OpenAI and ignores Slack approve/reject decisions.

**Rollback:** in n8n, open the workflow and switch it back to Active. To restore from a file: `n8n import:workflow --input=<file>`, then re-link credentials.

Credential entries hold placeholder IDs only. They contain no secret values.
Identifiers in these exports are replaced with placeholders; the workflows are archived and must stay inactive.
