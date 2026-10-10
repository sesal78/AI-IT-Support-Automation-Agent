import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVAL_SENSITIVE_TOPICS, evalTicketSchema, type EvalTicket } from "../src/eval-ticket.js";
import { redact } from "../src/redact.js";
import { ticketSubmissionSchema } from "../src/ticket.js";
import {
  ASSIGNMENT_GROUPS,
  CATEGORIES,
  DEFAULT_GROUP_FOR_CATEGORY,
  PRIORITIES,
  SECURITY_INCIDENT_GROUP,
  TRIAGE_FLAGS,
} from "../src/triage.js";

const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../../evals/tickets.json");
const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
const tickets = (raw as unknown[]).map((t) => evalTicketSchema.parse(t));
const inSet = (set: EvalTicket["set"]) => tickets.filter((t) => t.set === set);

describe("evals/tickets.json", () => {
  it("is an array of exactly 100 tickets with unique ids E001...E100", () => {
    expect(Array.isArray(raw)).toBe(true);
    expect(tickets).toHaveLength(100);
    expect(tickets.map((t) => t.id)).toEqual(
      Array.from({ length: 100 }, (_, i) => `E${String(i + 1).padStart(3, "0")}`),
    );
  });

  it("has 60 normal tickets, 10 per category", () => {
    expect(inSet("normal")).toHaveLength(60);
    for (const category of CATEGORIES) {
      const count = inSet("normal").filter((t) => t.expected.category === category).length;
      expect(count, category).toBe(10);
    }
  });

  it("has 20 sensitive tickets, 4 per topic", () => {
    expect(inSet("sensitive")).toHaveLength(20);
    for (const topic of EVAL_SENSITIVE_TOPICS) {
      const count = inSet("sensitive").filter((t) => t.expected.sensitiveTopic === topic).length;
      expect(count, topic).toBe(4);
    }
  });

  it("has 8 vague and 12 injection tickets", () => {
    expect(inSet("vague")).toHaveLength(8);
    expect(inSet("injection")).toHaveLength(12);
  });

  it("passes ticketSubmissionSchema on the form fields (no Turnstile token)", () => {
    const formSchema = ticketSubmissionSchema.omit({ turnstileToken: true });
    for (const t of tickets) {
      const { name, email, department, title, description } = t;
      const result = formSchema.safeParse({ name, email, department, title, description });
      expect(result.success, t.id).toBe(true);
    }
  });

  it("only uses members of the lists in triage.ts", () => {
    for (const t of tickets) {
      expect(CATEGORIES, t.id).toContain(t.expected.category);
      expect(PRIORITIES, t.id).toContain(t.expected.priority);
      expect(ASSIGNMENT_GROUPS, t.id).toContain(t.expected.assignmentGroup);
      for (const flag of t.expected.flags) expect(TRIAGE_FLAGS, t.id).toContain(flag);
    }
  });

  it("uses the default group of the category, or IT Securities for security_incident", () => {
    for (const t of tickets) {
      const want =
        t.expected.sensitiveTopic === "security_incident"
          ? SECURITY_INCIDENT_GROUP
          : DEFAULT_GROUP_FOR_CATEGORY[t.expected.category];
      expect(t.expected.assignmentGroup, t.id).toBe(want);
    }
  });

  it("routes every sensitive ticket to review with a topic", () => {
    for (const t of inSet("sensitive")) {
      expect(t.expected.route, t.id).toBe("review");
      expect(t.expected.sensitiveTopic, t.id).not.toBeNull();
    }
  });

  it("flags every vague ticket needs_info", () => {
    for (const t of inSet("vague")) expect(t.expected.flags, t.id).toContain("needs_info");
  });

  it("flags every injection ticket and gives it forbidden phrases", () => {
    for (const t of inSet("injection")) {
      expect(t.expected.flags, t.id).toContain("injection_suspected");
      expect(t.expected.forbiddenPhrases?.length ?? 0, t.id).toBeGreaterThan(0);
    }
  });

  it("has at least 4 injection tickets with a sensitive topic", () => {
    const withTopic = inSet("injection").filter((t) => t.expected.sensitiveTopic !== null);
    expect(withTopic.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps needs_info, injection_suspected and forbidden phrases to their own sets", () => {
    for (const t of tickets) {
      expect(t.expected.flags.includes("needs_info"), t.id).toBe(t.set === "vague");
      expect(t.expected.flags.includes("injection_suspected"), t.id).toBe(t.set === "injection");
      expect(t.expected.forbiddenPhrases !== undefined, t.id).toBe(t.set === "injection");
    }
  });

  it("sets route to review exactly when a review rule applies (evals/README.md)", () => {
    for (const t of tickets) {
      const mustReview =
        t.set !== "normal" ||
        t.expected.sensitiveTopic !== null ||
        t.expected.flags.length > 0 ||
        t.expected.priority === "P1";
      expect(t.expected.route, t.id).toBe(mustReview ? "review" : null);
    }
  });

  it("does not repeat a title or a description", () => {
    expect(new Set(tickets.map((t) => t.title.toLowerCase())).size).toBe(100);
    expect(new Set(tickets.map((t) => t.description)).size).toBe(100);
  });

  it("only holds example.com email addresses", () => {
    for (const t of tickets) {
      expect(t.email, t.id).toMatch(/@example\.com$/);
      const text = `${t.name} ${t.title} ${t.description}`;
      for (const address of text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? []) {
        expect(address, t.id).toMatch(/@example\.com$/);
      }
    }
  });

  it("holds synthetic personal data in at least 20 tickets, found by the redaction rules", () => {
    const types = new Set(["EMAIL", "PHONE", "IPV4"]);
    const withPii = tickets.filter((t) =>
      redact(t.description).log.some((entry) => types.has(entry.type)),
    );
    expect(withPii.length).toBeGreaterThanOrEqual(20);
  });

  it("uses only reserved phone and IP values", () => {
    const reservedIp = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;
    for (const t of tickets) {
      for (const ip of t.description.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
        expect(ip, t.id).toMatch(reservedIp);
      }
      for (const phone of t.description.match(/\b\d{3}-\d{3}-\d{4}\b/g) ?? []) {
        expect(phone, t.id).toMatch(/^\d{3}-555-01\d{2}$/);
      }
    }
  });

  it("holds no key-shaped secret (the redaction rules find none)", () => {
    const secrets = new Set(["AWS_KEY", "API_KEY", "GITHUB_TOKEN", "SLACK_TOKEN", "JWT"]);
    for (const t of tickets) {
      for (const entry of redact(`${t.title}\n${t.description}`).log) {
        expect(secrets.has(entry.type), `${t.id} ${entry.type}`).toBe(false);
      }
    }
  });
});
