---

# AI IT Support Automation Agent

**Enterprise-Grade Implementation Plan (v3 – Production & Ops Ready)**

---

## 🎯 Objective (Final Form)

Build an AI-powered IT Support Automation Agent that:

- Safely ingests and sanitises IT tickets
- Uses AI + internal knowledge (RAG) for classification and resolution suggestions
- Applies deterministic policy logic with **human oversight**
- Scales safely under load using **rate limiting & queuing**
- Integrates reliably with ServiceNow (create + update loop)
- Operates with **auditability, shadow validation, and rollback safety**

---

## 🧩 Final Architecture (Ops-Hardened)

```
Ticket Source
   ↓
Webhook / API
   ↓
Ingress Queue / Rate Limiter        ← NEW
   ↓
n8n Orchestrator
   ↓
PII / PHI Pre-Processing
   ↓
AI + RAG Classification
   ↓
Safety & Decision Engine
   ↓
Human-in-the-Loop Gate              ← NEW
   ↓
ServiceNow (Create / Update)
   ↓
Local State Store (sys_id)
   ↓
Logs, Error Triggers, Monitoring

```

---

# 🧱 PHASE 1 — Foundation, SDLC & Environments (Day 1–2)

*(Mostly unchanged, but clarified)*

### Key Enhancements

- Separate **Dev / Prod n8n environments**
- Separate API keys per environment
- Feature flags stored as environment variables:
    - `SHADOW_MODE=true`
    - `ENABLE_SERVICENOW=false`

These flags become critical later.

---

# 🧱 PHASE 2 — Ingestion + Concurrency Control (Day 3)

## 🔥 NEW: Concurrency & Rate Limiting Layer

### Problem Solved

- Ticket storms (e.g., email outage)
- ServiceNow API rate limits
- LLM token-per-minute caps

---

### Solution Options (Choose One)

### Option A: Native n8n (Good Enough for MVP)

- **Batch Node** (e.g., process 5 tickets at a time)
- **Wait Node** (delay between batches)
- **Concurrency set to 1** on critical workflows

### Option B: Message Queue (Enterprise-Grade)

- RabbitMQ / Redis / SQS
- Webhook → Queue → Worker Workflow
- Allows back-pressure without data loss

> Recommendation:
> 
> 
> Start with **n8n Batch + Wait**, document how you’d swap to RabbitMQ.
> 

---

### n8n Workflow: `00-Ticket-Queue`

**Nodes**

1. Webhook
2. Queue / Batch
3. Forward to Ingest Workflow

This protects *everything downstream*.

---

# 🧱 PHASE 3 — PII / PHI Pre-Processing (Day 4)

*(Same as v2, no changes — already strong)*

Key reminder:

- **Raw payload is immutable**
- Sanitised payload is what reaches AI

---

# 🧱 PHASE 4 — AI Classification + RAG (Day 5–6)

*(Same as v2, but now explicitly async-safe)*

### Additional Guardrail

- LLM calls happen **after queueing**
- Token usage logged per ticket
- Hard timeout + fallback path

---

# 🧱 PHASE 5 — Safety, Decision Engine & Human-in-the-Loop (Day 7)

## 🔥 NEW: Human-in-the-Loop Review UI

### Problem Solved

> “Confidence < 0.8 — where does the human review actually happen?”
> 

---

### Human Review Design (n8n-Native)

When a ticket requires human approval:

1. Workflow **pauses**
2. Notification sent to:
    - Slack / Teams
3. Message includes:
    - Ticket summary
    - AI suggestion
    - Confidence score
    - **Approve / Reject buttons**

---

### Implementation Options

### Option A: Slack / Teams Interactive Buttons (Best)

- Webhook buttons
- Approve → continue workflow
- Reject → escalate / manual ticket

### Option B: n8n Forms

- Simple approval form
- Form submission resumes workflow

---

### n8n Pattern Used

- **Wait Node**
- Resume on webhook callback
- Timeout fallback (e.g., 2 hours → auto-escalate)

```json
{
  "human_decision": "approved",
  "reviewer": "it.manager@company.com",
  "reviewed_at": "2025-01-21T10:42Z"
}

```

> This is a textbook enterprise AI governance pattern.
> 

---

# 🧱 PHASE 6 — Shadow Mode Validation (NEW, Day 8–9)

## 🛠 The “Shadow Mode” (Critical Refinement)

### Purpose

Validate AI decisions **before touching ServiceNow**.

---

### How Shadow Mode Works

For 48 hours:

- AI runs normally
- Decision Engine runs normally
- **ServiceNow calls are disabled**
- Everything is logged

Environment flag:

```
SHADOW_MODE=true

```

---

### What You Capture

| Field | Source |
| --- | --- |
| AI category | AI output |
| AI priority | AI output |
| Confidence score | AI |
| Human actual action | Service Desk |
| Delta | Logged |

---

### Outcome

You now have:

- Validation dataset
- Precision / recall estimates
- Evidence for stakeholders

> This is exactly how AI is rolled out in regulated environments.
> 

---

# 🧱 PHASE 7 — ServiceNow Create & Update Loop (Day 10)

*(Mostly unchanged, but now gated)*

### ServiceNow Calls Only If:

- `SHADOW_MODE=false`
- Confidence ≥ threshold **OR**
- Human approved

---

### ServiceNow Loop (Reinforced)

- Store `sys_id`
- Reuse `sys_id` for:
    - Updates
    - Comments
    - State changes

No duplicate incidents. Ever.

---

# 🧱 PHASE 8 — Logging, Errors & Global Recovery (Day 11)

## 🔥 Global Error Handling (Reinforced)

- n8n **Error Trigger Workflow**
- Captures:
    - Node failure
    - Payload
    - Stack trace
- Auto-actions:
    - Alert
    - Retry
    - Queue for manual handling

---

# 🧱 PHASE 9 — Monitoring, Metrics & Ops Readiness (Day 12)

### New Metrics Added

- Tickets queued vs processed
- Average queue delay
- Human override rate
- Shadow-mode accuracy
- API throttling incidents

---

# 🧱 PHASE 10 — Optional UI & Reporting (Stretch)

Now enhanced with:

- Shadow Mode comparison view
- Human approval history
- Confidence drift trends

---

