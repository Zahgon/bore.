//! Client-server authentication using a shared secret.
//!
//! Ported from `src/auth.rs`. The construction is deliberately reproduced
//! byte-for-byte so that a JavaScript client can talk to a Rust server and vice
//! versa:
//!
//! ```text
//! key    = SHA-256(secret)                     (32 raw bytes)
//! answer = hex(HMAC-SHA-256(key, challenge))   (lowercase, 64 chars)
//! ```
//!
//! where `challenge` is the **16 raw bytes** of the UUID, not its textual form.

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { Delimited } from "./delimited.ts";
import { parseClientMessage, parseServerMessage, parseUuid } from "./protocol.ts";

/// Converts a hyphenated UUID into the 16 raw bytes hashed by the Rust code
/// (`Uuid::as_bytes`).
export function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(parseUuid(uuid).replaceAll("-", ""), "hex");
}

/// Wrapper around a MAC used to authenticate clients.
export class Authenticator {
  readonly #key: Buffer;

  /// Generate an authenticator from a secret.
  constructor(secret: string) {
    this.#key = createHash("sha256").update(secret, "utf8").digest();
  }

  /// Generate a reply message for a challenge.
  answer(challenge: string): string {
    return createHmac("sha256", this.#key).update(uuidToBytes(challenge)).digest("hex");
  }

  /// Validate a reply message for a challenge.
  validate(challenge: string, tag: string): boolean {
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(tag)) return false; // `hex::decode` would fail
    const provided = Buffer.from(tag, "hex");
    const expected = Buffer.from(this.answer(challenge), "hex");
    if (provided.length !== expected.length) return false; // `verify_slice` length check
    return timingSafeEqual(provided, expected);
  }

  /// As the server, send a challenge to the client and validate their response.
  async serverHandshake(stream: Delimited): Promise<void> {
    const challenge = randomUUID();
    await stream.send({ kind: "Challenge", id: challenge });
    const message = await stream.recvTimeout(parseClientMessage);
    if (message === null || message.kind !== "Authenticate") {
      throw new Error("server requires secret, but no secret was provided");
    }
    if (!this.validate(challenge, message.tag)) {
      throw new Error("invalid secret");
    }
  }

  /// As the client, answer a challenge to attempt to authenticate with the
  /// server.
  async clientHandshake(stream: Delimited): Promise<void> {
    const message = await stream.recvTimeout(parseServerMessage);
    if (message === null || message.kind !== "Challenge") {
      throw new Error("expected authentication challenge, but no secret was required");
    }
    await stream.send({ kind: "Authenticate", tag: this.answer(message.id) });
  }
}
