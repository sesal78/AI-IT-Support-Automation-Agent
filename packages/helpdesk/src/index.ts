export { HelpdeskError, InstanceAsleepError, type HelpdeskErrorCode } from "./errors.js";
export { FakeConnector, type FakeCall } from "./fake.js";
export {
  withShadowMode,
  shadowEnabled,
  type ShadowOperation,
  type ShadowOptions,
} from "./shadow.js";
export {
  UPDATE_STATES,
  type CreateHelpdeskTicketInput,
  type CreatedHelpdeskTicket,
  type HelpdeskConnector,
  type HelpdeskHealth,
  type HelpdeskKind,
  type HelpdeskTicketRef,
  type HelpdeskTicketState,
  type HelpdeskUpdateState,
  type ShadowSkip,
} from "./types.js";
export { MAX_NOTE_LENGTH, assertNoteBody, assertTicketId, assertUpdateState } from "./validate.js";
export * from "./servicenow/index.js";
