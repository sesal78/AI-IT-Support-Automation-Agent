export {
  assertHeaderSafe,
  EmailHeaderError,
  isAllowedRecipient,
  parseRecipient,
} from "./headers.js";
export { createResendClient, EmailProviderError } from "./resend.js";
export type { ResendClient, ResendClientOptions, SendEmailInput } from "./resend.js";
export { buildReplyEmail } from "./template.js";
export type { ReplyEmail, ReplyEmailInput } from "./template.js";
