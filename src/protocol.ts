//! Protocol constants and the wire encoding of control messages.
//!
//! Ported from the `ClientMessage` / `ServerMessage` enums in `src/shared.rs`.
//!
//! The Rust implementation derives `serde::{Serialize, Deserialize}` on plain
//! enums, which produces serde's **externally tagged** representation:
//!
//! | Rust                                | JSON                            |
//! | ----------------------------------- | ------------------------------- |
//! | `ClientMessage::Authenticate(tag)`  | `{"Authenticate":"<hex>"}`      |
//! | `ClientMessage::Hello(port)`        | `{"Hello":8000}`                |
//! | `ClientMessage::Accept(uuid)`       | `{"Accept":"<uuid>"}`           |
//! | `ServerMessage::Challenge(uuid)`    | `{"Challenge":"<uuid>"}`        |
//! | `ServerMessage::Hello(port)`        | `{"Hello":41234}`               |
//! | `ServerMessage::Heartbeat`          | `"Heartbeat"`                   |
//! | `ServerMessage::Connection(uuid)`   | `{"Connection":"<uuid>"}`       |
//! | `ServerMessage::Error(message)`     | `{"Error":"..."}`               |
//!
//! Note that `Heartbeat` is a **unit variant** and therefore serialises to a
//! bare JSON string, not to an object. Getting this wrong is the single most
//! common way to break interoperability with the Rust implementation.

/// TCP port used for control connections with the server.
export const CONTROL_PORT = 7835;

/// Maximum byte length for a JSON frame in the stream.
export const MAX_FRAME_LENGTH = 256;

/// Timeout for network connections and initial protocol messages.
export const NETWORK_TIMEOUT_MS = 3000;

/// A message from the client on the control connection.
export type ClientMessage =
  /// Response to an authentication challenge from the server.
  | { readonly kind: "Authenticate"; readonly tag: string }
  /// Initial client message specifying a port to forward.
  | { readonly kind: "Hello"; readonly port: number }
  /// Accepts an incoming TCP connection, using this stream as a proxy.
  | { readonly kind: "Accept"; readonly id: string };

/// A message from the server on the control connection.
export type ServerMessage =
  /// Authentication challenge, sent as the first message, if enabled.
  | { readonly kind: "Challenge"; readonly id: string }
  /// Response to a client's initial message, with actual public port.
  | { readonly kind: "Hello"; readonly port: number }
  /// No-op used to test if the client is still reachable.
  | { readonly kind: "Heartbeat" }
  /// Asks the client to accept a forwarded TCP connection.
  | { readonly kind: "Connection"; readonly id: string }
  /// Indicates a server error that terminates the connection.
  | { readonly kind: "Error"; readonly message: string };

export type Message = ClientMessage | ServerMessage;

/// Error raised when a frame cannot be decoded into a protocol message.
///
/// Mirrors `.context("unable to parse message")` in `Delimited::recv`.
export class ProtocolError extends Error {
  constructor(message = "unable to parse message", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProtocolError";
  }
}

/// Serialises a message into its JSON payload (without the null terminator).
///
/// `Hello` is shared between `ClientMessage` and `ServerMessage` and encodes
/// identically in both directions, so a single encoder covers both enums.
export function encodeMessage(message: Message): string {
  switch (message.kind) {
    case "Authenticate":
      return JSON.stringify({ Authenticate: message.tag });
    case "Hello":
      return JSON.stringify({ Hello: message.port });
    case "Accept":
      return JSON.stringify({ Accept: message.id });
    case "Challenge":
      return JSON.stringify({ Challenge: message.id });
    case "Heartbeat":
      return JSON.stringify("Heartbeat");
    case "Connection":
      return JSON.stringify({ Connection: message.id });
    case "Error":
      return JSON.stringify({ Error: message.message });
  }
}

const HYPHENATED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SIMPLE = /^[0-9a-fA-F]{32}$/;

/// Parses a UUID the way `uuid::Uuid`'s `serde` impl does, accepting both the
/// hyphenated and the simple form, and normalising to lowercase hyphenated.
export function parseUuid(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError();
  const unprefixed = value.startsWith("urn:uuid:") ? value.slice("urn:uuid:".length) : value;
  const trimmed =
    unprefixed.startsWith("{") && unprefixed.endsWith("}")
      ? unprefixed.slice(1, -1)
      : unprefixed;
  if (HYPHENATED.test(trimmed)) return trimmed.toLowerCase();
  if (SIMPLE.test(trimmed)) {
    const hex = trimmed.toLowerCase();
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join("-");
  }
  throw new ProtocolError();
}

/// Parses a `u16` the way serde does: an integer within `0..=65535`.
function parsePort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ProtocolError();
  }
  return value;
}

function parseString(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError();
  return value;
}

/// Externally tagged enums are encoded as single-key objects; serde rejects
/// objects carrying more (or fewer) than one key.
function soleEntry(value: unknown): readonly [string, unknown] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError();
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const entry = entries[0];
  if (entries.length !== 1 || entry === undefined) throw new ProtocolError();
  return entry;
}

/// Deserialises a `ClientMessage` from already-parsed JSON.
export function parseClientMessage(value: unknown): ClientMessage {
  // `ClientMessage` has no unit variants, so a bare string is always invalid.
  const [tag, payload] = soleEntry(value);
  switch (tag) {
    case "Authenticate":
      return { kind: "Authenticate", tag: parseString(payload) };
    case "Hello":
      return { kind: "Hello", port: parsePort(payload) };
    case "Accept":
      return { kind: "Accept", id: parseUuid(payload) };
    default:
      throw new ProtocolError();
  }
}

/// Deserialises a `ServerMessage` from already-parsed JSON.
export function parseServerMessage(value: unknown): ServerMessage {
  if (typeof value === "string") {
    // Only unit variants deserialise from a bare string.
    if (value === "Heartbeat") return { kind: "Heartbeat" };
    throw new ProtocolError();
  }
  const [tag, payload] = soleEntry(value);
  switch (tag) {
    case "Challenge":
      return { kind: "Challenge", id: parseUuid(payload) };
    case "Hello":
      return { kind: "Hello", port: parsePort(payload) };
    case "Connection":
      return { kind: "Connection", id: parseUuid(payload) };
    case "Error":
      return { kind: "Error", message: parseString(payload) };
    default:
      throw new ProtocolError();
  }
}
