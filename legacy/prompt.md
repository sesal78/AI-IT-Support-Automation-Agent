You are an expert automation engineer tasked with building a **production-grade n8n workflow** called "AI IT Support Automation Agent", integrated with ServiceNow. The system must process IT support tickets end-to-end, provide AI-assisted classification and suggested resolutions, handle escalations, logging, and auditability, and support enterprise-grade safety, concurrency, and compliance requirements.

---

### **Requirements**

1. **Ticket Intake**
   - Tickets arrive via webhook (Slack, Teams, Email, API).
   - Pre-process the ticket:
     - **Redact PII/PHI** (passwords, health info, or sensitive identifiers) before sending to AI.
     - Validate JSON schema:
       {
       "title": "string",
       "description": "string",
       "category": "string",
       "priority": "string",
       "urgency": "string",
       "suggested_resolution": "string"
       }
   - Store raw and sanitized tickets in a local database/log for auditing.

2. **AI Classification & Resolution**
   - Call an LLM (OpenAI / Anthropic) to:
     - Classify the ticket (category, priority, urgency)
     - Suggest a resolution
     - Provide a confidence score (0–1)
   - Use **Few-Shot Prompting**: Provide 3–5 examples of "bad input → correct JSON output".
   - Integrate **RAG (retrieval-augmented generation)** using the company SOPs/knowledge base for context-aware resolutions.
   - For sensitive categories like "Legal", "Executive", "Termination", automatically bypass AI and escalate.

3. **Decision Logic & Human-in-the-Loop**
   - If **confidence < 0.8**:
     - Pause workflow using **n8n Wait nodes** or **Forms**.
     - Notify human via Slack/Teams with Approve/Reject buttons.
     - Resume workflow only after human input.
   - Implement **Safety Overrides** for sensitive ticket types (legal, exec, termination).

4. **ServiceNow Integration**
   - **Create or Update tickets**:
     - For new tickets: create via ServiceNow API, store `sys_id` locally.
     - For existing tickets: update via `sys_id`.
   - Implement **Shadow Mode** for 48 hours:
     - Log AI classification, decision, and suggested resolution.
     - Do **not** create or update tickets.
     - Use results for validation against human actions.

5. **Concurrency & Rate Limiting**
   - Ensure **Message Queue** or **n8n batching/wait nodes** to prevent LLM or ServiceNow API overload during high-volume ticket storms.
   - Handle API rate limits gracefully.

6. **Logging, Monitoring & Error Handling**
   - Use **n8n Error Trigger Workflow** for global catch-all error handling.
   - Log all AI outputs, decisions, ServiceNow responses, and human overrides.
   - Track metrics for Shadow Mode validation and system performance.

7. **Environment & Deployment**
   - Separate **Development** and **Production** environments in n8n.
   - Store API keys securely (ServiceNow, LLM, Slack, Teams).
   - Provide documentation for all workflow nodes with descriptions, inputs/outputs, and examples.
   - Include optional Vercel-hosted server endpoints for ticket intake webhooks if required.

---

### **Deliverables**
- A complete **n8n workflow JSON** ready for import.
- Example ticket payloads for testing.
- Shadow Mode instructions and validation reporting.
- Node-by-node documentation explaining purpose, inputs, outputs, and fallback behavior.

---

**Note:** The AI must **strictly adhere to JSON output schema**, implement PII/PHI redaction, respect concurrency limits, and include Human-in-the-Loop approval for low-confidence tickets. Safety and auditability are critical.
