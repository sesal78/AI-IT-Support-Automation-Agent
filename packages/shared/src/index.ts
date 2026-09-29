// Shared zod schemas and category maps land here in later phases.
export const packageName = "@ai-it-support/shared";

export { formatEnvIssues, parseEnv, phase1EnvShape, type EnvIssue } from "./env.js";
export { redact, type RedactionResult, type RedactionType } from "./redact.js";
