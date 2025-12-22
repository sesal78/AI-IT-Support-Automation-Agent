# AI IT Support Automation Agent - Node Documentation

## Workflow Overview

This document provides detailed documentation for each node in the AI IT Support Automation Agent workflow.

---

## PHASE 1: Ticket Intake & Rate Limiting

### 1. Webhook - Ticket Intake

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.webhook` |
| **Version** | 2.1 |
| **Purpose** | Primary entry point for all IT support tickets |

**Inputs:**
```json
{
  "title": "string (required)",
  "description": "string (required)",
  "category": "string (optional)",
  "priority": "string (optional)",
  "urgency": "string (optional)",
  "requester_email": "string (optional)",
  "sys_id": "string (optional - for updates)",
  "source": "string (optional - slack/teams/email/api)"
}
```

**Outputs:**
- Raw ticket payload forwarded to rate limiter

**Configuration:**
- Path: `/ticket-intake`
- Method: `POST`
- Response Mode: `responseNode` (response sent at end of workflow)

**Fallback Behavior:**
- On error: Continue with regular output (logged but not fatal)

---

### 2. Rate Limiter - Batch Control

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.splitInBatches` |
| **Version** | 3 |
| **Purpose** | Prevents API overload during ticket storms |

**Configuration:**
- Batch Size: 5 tickets per batch
- Processes tickets sequentially to respect rate limits

**Outputs:**
- Output 0: Loop back for next batch
- Output 1: Current batch items to process

---

### 3. Wait Between Batches

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.wait` |
| **Version** | 1.1 |
| **Purpose** | Rate limiting delay between batch processing |

**Configuration:**
- Wait: 2 seconds between batches
- Prevents LLM and ServiceNow API throttling

---

## PHASE 2: Audit & Validation

### 4. Store Raw Ticket (Audit)

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.code` |
| **Version** | 2 |
| **Purpose** | Creates immutable audit record of raw ticket |

**Inputs:**
- Raw ticket from webhook

**Outputs:**
```json
{
  "id": "TKT-{timestamp}",
  "received_at": "ISO timestamp",
  "source": "webhook source",
  "raw_payload": "stringified original payload",
  "processing_status": "received",
  "original": { /* original ticket data */ }
}
```

**Compliance Notes:**
- Raw payload is never modified
- Used for audit trail and debugging
- In production: Write to database

---

### 5. Validate JSON Schema

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.code` |
| **Version** | 2 |
| **Purpose** | Validates ticket against required schema |

**Validation Rules:**
- `title`: Required, must be string
- `description`: Required, must be string
- Other fields: Optional with defaults

**Outputs:**
```json
{
  "is_valid": true/false,
  "validation_errors": ["array of error messages"],
  "title": "string",
  "description": "string",
  "category": "string (default: uncategorized)",
  "priority": "string (default: medium)",
  "urgency": "string (default: medium)",
  "sys_id": "string or null",
  "is_update": true/false
}
```

---

### 6. Validation Check

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.if` |
| **Version** | 2.3 |
| **Purpose** | Routes tickets based on validation result |

**Routing:**
- **True (Valid)**: → PII/PHI Redaction
- **False (Invalid)**: → Validation Error Handler

---

### 7. Validation Error Handler

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.code` |
| **Version** | 2 |
| **Purpose** | Structures validation error response |

**Outputs:**
```json
{
  "success": false,
  "error": "Validation failed",
  "validation_errors": ["list of errors"],
  "ticket_id": "string",
  "received_at": "timestamp"
}
```

---

### 8. Error Response

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.respondToWebhook` |
| **Version** | 1.5 |
| **Purpose** | Returns 400 error for invalid tickets |

**HTTP Response:**
- Status: 400 Bad Request
- Body: JSON with validation errors

---

## PHASE 3: PII/PHI Protection

### 9. PII/PHI Redaction

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.code` |
| **Version** | 2 |
| **Purpose** | Redacts sensitive information before AI processing |

**Redaction Patterns:**

| Type | Pattern | Replacement |
|------|---------|-------------|
| Email | `user@domain.com` | `[REDACTED_EMAIL]` |
| Phone | `555-123-4567` | `[REDACTED_PHONE]` |
| SSN | `123-45-6789` | `[REDACTED_SSN]` |
| Credit Card | `4242-4242-4242-4242` | `[REDACTED_CREDITCARD]` |
| IP Address | `192.168.1.1` | `[REDACTED_IPADDRESS]` |
| Password | `password: secret123` | `[REDACTED_PASSWORD]` |
| API Key | `api_key: sk-xxx` | `[REDACTED_APIKEY]` |
| PHI | `diagnosis: diabetes` | `[REDACTED_PHI]` |

**Outputs:**
```json
{
  "title_sanitized": "redacted title",
  "description_sanitized": "redacted description",
  "title_original": "preserved for audit",
  "description_original": "preserved for audit",
  "redaction_log": {
    "title_redactions": [{"type": "email", "count": 1}],
    "description_redactions": [...],
    "redacted_at": "timestamp"
  }
}
```

---

## PHASE 4: Sensitive Category Handling

### 10. Sensitive Category Bypass

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.if` |
| **Version** | 2.3 |
| **Purpose** | Bypasses AI for sensitive ticket categories |

**Trigger Keywords (case-insensitive):**
- `legal`
- `executive`
- `termination`

**Routing:**
- **True (Sensitive)**: → Direct Escalation
- **False (Normal)**: → RAG Context Retrieval

---

### 11. Direct Escalation (Sensitive)

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.set` |
| **Version** | 3.4 |
| **Purpose** | Marks ticket for immediate human escalation |

**Sets:**
```json
{
  "ai_bypassed": true,
  "bypass_reason": "Sensitive category detected - automatic escalation",
  "priority": "critical",
  "requires_human_review": true
}
```

---

## PHASE 5: AI Classification

### 12. RAG - Knowledge Base Retrieval

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.httpRequest` |
| **Version** | 4.3 |
| **Purpose** | Retrieves relevant SOP/KB context for AI |

**Request:**
- Method: POST
- URL: `$env.RAG_ENDPOINT`
- Body: Query with ticket title/description

**Outputs:**
```json
{
  "context": "Relevant knowledge base content...",
  "sources": ["sop-123.md", "kb-456.md"]
}
```

**Fallback:**
- On error: Continue with empty context

---

### 13. AI Classification (OpenAI)

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.httpRequest` |
| **Version** | 4.3 |
| **Purpose** | LLM classification with few-shot prompting |

**API Configuration:**
- Endpoint: `https://api.openai.com/v1/chat/completions`
- Model: `gpt-4o`
- Temperature: 0.1 (low for consistency)
- Max Tokens: 500

**Few-Shot Examples Included:**
1. Password reset → Email/Authentication
2. Slow computer → Hardware/Performance
3. Software request → Software/Installation
4. VPN issues → Network/VPN
5. Printer jam → Hardware/Printer

**Output Schema:**
```json
{
  "category": "Email/Authentication|Hardware/Performance|...",
  "priority": "critical|high|medium|low",
  "urgency": "critical|high|medium|low",
  "suggested_resolution": "Step-by-step resolution...",
  "confidence": 0.0-1.0
}
```

---

### 14. Parse AI Response

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.code` |
| **Version** | 2 |
| **Purpose** | Parses and validates AI JSON response |

**Logic:**
1. Extract message content from OpenAI response
2. Parse JSON (with fallback for parse errors)
3. Validate confidence is 0-1
4. Merge with ticket data

**Outputs:**
```json
{
  "ai_classification": {
    "category": "string",
    "priority": "string",
    "urgency": "string",
    "suggested_resolution": "string",
    "confidence": 0.85,
    "classified_at": "timestamp",
    "model": "gpt-4o"
  },
  "ai_bypassed": false,
  "requires_human_review": false
}
```

---

## PHASE 6: Human-in-the-Loop

### 15. Confidence Threshold Check

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.if` |
| **Version** | 2.3 |
| **Purpose** | Routes based on AI confidence score |

**Threshold:** 0.8 (80%)

**Routing:**
- **≥ 0.8**: → Merge Processing Paths (auto-approve)
- **< 0.8**: → Human Review Notification

---

### 16. Human Review - Slack Notification

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.httpRequest` |
| **Version** | 4.3 |
| **Purpose** | Sends approval request to Slack |

**Message Format:**
```
*IT Ticket Requires Review*
Ticket: TKT-123456
Title: Cannot login to email
AI Category: Email/Authentication
Confidence: 0.72
Suggested: Reset user password...

[Approve] [Reject]
```

---

### 17. Wait for Human Decision

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.wait` |
| **Version** | 1.1 |
| **Purpose** | Pauses workflow until human responds |

**Configuration:**
- Resume: Webhook callback
- Webhook Suffix: Ticket ID

**Expected Callback:**
```json
{
  "human_decision": "approved|rejected",
  "reviewer": "email@company.com",
  "reviewed_at": "timestamp"
}
```

---

### 18. Merge Processing Paths

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.merge` |
| **Version** | 3.2 |
| **Purpose** | Combines auto-approved and human-approved paths |

**Inputs:**
1. High-confidence auto-approved tickets
2. Human-approved tickets
3. Sensitive category escalations

---

## PHASE 7: Shadow Mode & ServiceNow

### 19. Shadow Mode Check

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.if` |
| **Version** | 2.3 |
| **Purpose** | Controls shadow mode behavior |

**Environment Variable:** `SHADOW_MODE`

**Routing:**
- **"true"**: → Shadow Mode Log (no ServiceNow)
- **"false"**: → ServiceNow Create or Update

---

### 20. Shadow Mode - Log Only

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.code` |
| **Version** | 2 |
| **Purpose** | Logs AI decision without ServiceNow action |

**Outputs:**
```json
{
  "shadow_mode": true,
  "status": "shadow_logged",
  "ai_decision": {...},
  "servicenow_action": {
    "would_create": true,
    "would_update": false
  },
  "validation": {
    "pending_human_comparison": true
  }
}
```

---

### 21. ServiceNow Create or Update

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.if` |
| **Version** | 2.3 |
| **Purpose** | Determines ServiceNow action type |

**Logic:**
- If `sys_id` exists → Update
- If no `sys_id` → Create

---

### 22. ServiceNow - Create Incident

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.httpRequest` |
| **Version** | 4.3 |
| **Purpose** | Creates new incident in ServiceNow |

**API:**
- Method: POST
- URL: `$env.SERVICENOW_INSTANCE/api/now/table/incident`
- Auth: HTTP Basic

**Request Body:**
```json
{
  "short_description": "Ticket title",
  "description": "Full description + AI suggestion",
  "category": "AI classified category",
  "priority": "1-4",
  "urgency": "1-4",
  "caller_id": "requester email",
  "u_ai_classified": "true",
  "u_ai_confidence": "0.85"
}
```

---

### 23. ServiceNow - Update Incident

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.httpRequest` |
| **Version** | 4.3 |
| **Purpose** | Updates existing incident |

**API:**
- Method: PATCH
- URL: `$env.SERVICENOW_INSTANCE/api/now/table/incident/{sys_id}`

**Request Body:**
```json
{
  "work_notes": "AI Update with new classification",
  "priority": "updated priority"
}
```

---

### 24. Store sys_id Response

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.code` |
| **Version** | 2 |
| **Purpose** | Captures ServiceNow response for tracking |

**Outputs:**
```json
{
  "ticket_id": "internal ID",
  "sys_id": "ServiceNow sys_id",
  "servicenow_number": "INC0012345",
  "action_taken": "created|updated",
  "action_timestamp": "timestamp"
}
```

---

## PHASE 8: Completion

### 25. Final Audit Log

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.code` |
| **Version** | 2 |
| **Purpose** | Creates comprehensive audit entry |

**Outputs:**
```json
{
  "audit_id": "AUD-{timestamp}",
  "timestamp": "ISO timestamp",
  "workflow_execution_id": "n8n execution ID",
  "ticket": {
    "id": "ticket ID",
    "sys_id": "ServiceNow ID",
    "servicenow_number": "INC number"
  },
  "processing": {
    "shadow_mode": false,
    "ai_bypassed": false,
    "human_reviewed": true,
    "action_taken": "created"
  },
  "ai_metrics": {
    "confidence": 0.85,
    "category": "Email/Authentication"
  },
  "status": "completed"
}
```

---

### 26. Webhook Response

| Property | Value |
|----------|-------|
| **Node Type** | `n8n-nodes-base.respondToWebhook` |
| **Version** | 1.5 |
| **Purpose** | Returns success response to caller |

**Response (200 OK):**
```json
{
  "success": true,
  "ticket_id": "TKT-123456",
  "sys_id": "abc123...",
  "status": "completed",
  "audit_id": "AUD-123456"
}
```

---

## Environment Variables Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `SHADOW_MODE` | Enable shadow mode (`true`/`false`) | Yes |
| `SERVICENOW_INSTANCE` | ServiceNow base URL | Yes |
| `RAG_ENDPOINT` | Knowledge base search API | No |
| `SLACK_WEBHOOK_URL` | Slack notification webhook | No |
| `SLACK_ALERT_WEBHOOK` | Slack alert webhook | No |
| `DEFAULT_ASSIGNMENT_GROUP` | Default ServiceNow group | No |

---

## Credentials Required

1. **ServiceNow** - HTTP Basic Auth (username/password)
2. **OpenAI** - HTTP Header Auth (Authorization: Bearer sk-xxx)
3. **Slack** - Webhook URLs (no auth needed)

---

## Error Handling Summary

| Node | Error Behavior |
|------|----------------|
| Webhook | Continue on error |
| RAG Retrieval | Continue with empty context |
| AI Classification | Continue with fallback response |
| ServiceNow Create/Update | Continue, log error |
| Human Review Slack | Continue, log error |
