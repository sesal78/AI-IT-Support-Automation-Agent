# Shadow Mode - Instructions & Validation Guide

## Overview

Shadow Mode is a critical validation feature that allows the AI IT Support Agent to run in a "dry-run" state for 48 hours before going live. During this period, the system processes tickets normally but **does not** create or update ServiceNow incidents.

## Purpose

1. **Validate AI Accuracy** - Compare AI classifications against actual human decisions
2. **Build Confidence** - Generate evidence for stakeholders before production deployment
3. **Risk Mitigation** - Catch edge cases and misclassifications without impacting production
4. **Compliance** - Document AI decision-making for audit purposes

---

## Enabling Shadow Mode

### Environment Variables

Set the following environment variable in your n8n instance:

```bash
SHADOW_MODE=true
```

### n8n Configuration Methods

**Option 1: n8n UI**
1. Go to **Settings** → **Environment Variables**
2. Add: `SHADOW_MODE` = `true`
3. Restart the workflow

**Option 2: Docker**
```yaml
environment:
  - SHADOW_MODE=true
```

**Option 3: .env file**
```
SHADOW_MODE=true
```

---

## What Happens in Shadow Mode

| Component | Normal Mode | Shadow Mode |
|-----------|-------------|-------------|
| Ticket Intake | ✅ Active | ✅ Active |
| PII Redaction | ✅ Active | ✅ Active |
| AI Classification | ✅ Active | ✅ Active |
| Human-in-Loop | ✅ Active | ✅ Active |
| ServiceNow Create | ✅ Active | ❌ Disabled |
| ServiceNow Update | ✅ Active | ❌ Disabled |
| Logging | ✅ Active | ✅ Enhanced |

---

## Shadow Mode Log Format

Every ticket processed generates a shadow log entry:

```json
{
  "shadow_mode": true,
  "logged_at": "2025-01-21T10:30:00Z",
  "ticket_id": "TKT-1705831800000",
  
  "ai_decision": {
    "category": "Email/Authentication",
    "priority": "high",
    "urgency": "high",
    "suggested_resolution": "Reset user password via Active Directory...",
    "confidence": 0.92,
    "ai_bypassed": false
  },
  
  "human_review": {
    "required": false,
    "decision": null,
    "reviewer": null
  },
  
  "servicenow_action": {
    "would_create": true,
    "would_update": false,
    "sys_id": null
  },
  
  "validation": {
    "pending_human_comparison": true,
    "actual_human_action": null,
    "accuracy_score": null
  }
}
```

---

## Validation Process

### Step 1: Enable Shadow Mode (Day 0)

```bash
# Set environment variable
SHADOW_MODE=true

# Deploy workflow
n8n import:workflow --input=01-main-it-support-agent.json
```

### Step 2: Collect Data (Days 1-2)

- Let the workflow process tickets normally
- All AI decisions are logged but ServiceNow is not touched
- Tickets continue to be handled manually by Service Desk

### Step 3: Extract Validation Data

Query the shadow mode logs to compare:

```javascript
// Sample query for validation comparison
const shadowLogs = await db.query(`
  SELECT 
    ticket_id,
    ai_decision_category,
    ai_decision_priority,
    ai_confidence,
    actual_human_category,
    actual_human_priority
  FROM shadow_mode_logs
  WHERE logged_at >= NOW() - INTERVAL '48 hours'
`);
```

### Step 4: Calculate Metrics

| Metric | Formula | Target |
|--------|---------|--------|
| Category Accuracy | (AI matches human) / total | > 85% |
| Priority Accuracy | (AI matches human) / total | > 80% |
| Avg Confidence | mean(confidence) | > 0.75 |
| Human Override Rate | (confidence < 0.8) / total | < 25% |

### Step 5: Validation Report

Generate a report before going live:

```
=== Shadow Mode Validation Report ===
Period: 2025-01-19 to 2025-01-21
Total Tickets Processed: 247

ACCURACY METRICS:
- Category Match Rate: 89.1% ✅
- Priority Match Rate: 84.6% ✅
- Urgency Match Rate: 82.3% ✅
- Average Confidence: 0.81 ✅

HUMAN REVIEW METRICS:
- Tickets Requiring Review: 42 (17%)
- Human Overrides: 27 (10.9%)

SENSITIVE CATEGORY BYPASS:
- Legal: 3 (correctly bypassed)
- Executive: 7 (correctly bypassed)
- Termination: 2 (correctly bypassed)

RECOMMENDATION: ✅ Ready for Production
```

### Step 6: Disable Shadow Mode (Day 3+)

Once validation passes:

```bash
SHADOW_MODE=false
```

---

## Monitoring During Shadow Mode

### Key Metrics to Track

1. **Tickets Processed per Hour** - Establish baseline
2. **AI Response Time** - Average LLM latency
3. **Confidence Distribution** - Histogram of scores
4. **Error Rate** - Failed classifications
5. **PII Redactions** - Count by type

### Alerts to Configure

```json
{
  "alert_rules": [
    {
      "name": "Low Confidence Spike",
      "condition": "count(confidence < 0.5) > 10 in 1 hour",
      "action": "slack_alert"
    },
    {
      "name": "Error Rate High",
      "condition": "error_rate > 5%",
      "action": "pagerduty"
    },
    {
      "name": "No Tickets Processed",
      "condition": "count(tickets) = 0 in 30 minutes",
      "action": "slack_alert"
    }
  ]
}
```

---

## Rollback Procedure

If issues are discovered during shadow mode:

1. **Keep Shadow Mode Enabled** - `SHADOW_MODE=true`
2. **Review Error Logs** - Check `02-error-handler` workflow executions
3. **Adjust Prompts** - Modify AI classification prompts if accuracy is low
4. **Retrain if Needed** - Update few-shot examples
5. **Re-run Validation** - Reset 48-hour period

---

## Post-Shadow Mode Checklist

Before disabling shadow mode:

- [ ] Category accuracy > 85%
- [ ] Priority accuracy > 80%
- [ ] Average confidence > 0.75
- [ ] Human override rate < 25%
- [ ] No critical errors in logs
- [ ] Stakeholder approval obtained
- [ ] Rollback plan documented
- [ ] Monitoring dashboards ready
- [ ] On-call schedule confirmed

---

## FAQ

**Q: Can I extend shadow mode beyond 48 hours?**
A: Yes, keep `SHADOW_MODE=true` as long as needed. The 48-hour period is a minimum recommendation.

**Q: What if my accuracy is below threshold?**
A: Review misclassified tickets, update few-shot examples in the AI prompt, and restart the validation period.

**Q: Do I need to re-enable shadow mode after updates?**
A: Yes, any significant changes to the AI classification logic should trigger a new shadow mode period.

**Q: How do I compare AI decisions with actual human actions?**
A: Export shadow logs and match against ServiceNow incident data using ticket IDs or timestamps.
