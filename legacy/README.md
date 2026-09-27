# AI IT Support Automation Agent

Production-ready n8n workflow for autonomous IT support ticket processing with AI classification, human-in-the-loop approval, and ServiceNow integration.

## Quick Start

1. **Import workflow**: `n8n import:workflow --input=workflows/01-main-it-support-agent.json`
2. **Set environment variables**:
   ```bash
   SHADOW_MODE=true
   SERVICENOW_INSTANCE=https://your-instance.service-now.com
   ```
3. **Configure credentials** in n8n UI for ServiceNow and OpenAI
4. **Activate workflow** and send test payload

## Project Structure

```
AI IT Support Automation Agent/
├── workflows/
│   ├── 01-main-it-support-agent.json  # Main workflow (26 nodes)
│   └── 02-error-handler.json          # Error handling workflow
├── docs/
│   ├── shadow-mode-instructions.md    # 48-hour validation guide
│   └── node-documentation.md          # Node-by-node reference
├── test-payloads/
│   └── test-tickets.json              # 15 test scenarios
└── README.md
```

## Features

- **AI Classification** - GPT-4o with few-shot prompting (85%+ accuracy)
- **Human-in-the-Loop** - Slack approval for low-confidence decisions
- **PII Redaction** - Automatic redaction of SSN, emails, credit cards, etc.
- **Sensitive Category Bypass** - Legal/Executive/Termination tickets bypass AI
- **Shadow Mode** - 48-hour validation before production
- **Rate Limiting** - Batch processing prevents API overload
- **ServiceNow Integration** - Create/update incidents automatically

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SHADOW_MODE` | Yes | `true` for validation, `false` for production |
| `SERVICENOW_INSTANCE` | Yes | ServiceNow base URL |
| `RAG_ENDPOINT` | No | Knowledge base search API |
| `SLACK_WEBHOOK_URL` | No | Human approval notifications |

## API Endpoint

```bash
POST /webhook/ticket-intake
Content-Type: application/json

{
  "title": "Cannot login to email",
  "description": "Forgot password, need urgent access",
  "requester_email": "user@company.com",
  "source": "slack"
}
```

## Validation Targets

Before disabling shadow mode, ensure:
- Category accuracy > 85%
- Priority accuracy > 80%
- Average confidence > 0.75
- Human override rate < 25%

## License

Internal use only.
