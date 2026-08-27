//! Shared data structures, utilities, and protocol definitions.
//!
//! This mirrors the public surface of `src/shared.rs`. The implementation is
//! split across `protocol.ts` (constants and message codec), `delimited.ts`
//! (the null-delimited framed stream) and `net.ts` (socket helpers) to keep
//! each module small, but everything is re-exported here so that consumers can
//! keep using a single `shared` entry point.

export {
  CONTROL_PORT,
  MAX_FRAME_LENGTH,
  NETWORK_TIMEOUT_MS,
  ProtocolError,
  encodeMessage,
  parseClientMessage,
  parseServerMessage,
  parseUuid,
  type ClientMessage,
  type Message,
  type ServerMessage,
} from "./protocol.ts";

export { Delimited, FrameError, TimeoutError, type DelimitedParts } from "./delimited.ts";

export {
  connectWithTimeout,
  context,
  copyBidirectional,
  formatErrorChain,
  ignoreErrors,
  writeAll,
} from "./net.ts";
