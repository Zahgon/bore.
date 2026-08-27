//! Wire-format and framing tests for `src/shared.rs`'s port.
//!
//! The golden JSON payloads were produced by `serde_json::to_string` on the
//! real `bore_cli::shared` enums.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_PORT,
  Delimited,
  FrameError,
  MAX_FRAME_LENGTH,
  NETWORK_TIMEOUT_MS,
  ProtocolError,
  TimeoutError,
  copyBidirectional,
  encodeMessage,
  parseClientMessage,
  parseServerMessage,
  parseUuid,
  type Message,
} from "../src/shared.ts";
import { duplexPair, StreamReader, writeAll } from "./support.ts";

const UUID = "b0f7f6cc-e1de-4a0d-a1cf-4e8f2b6f3c9a";

test("constants match the Rust source", () => {
  assert.equal(CONTROL_PORT, 7835);
  assert.equal(MAX_FRAME_LENGTH, 256);
  assert.equal(NETWORK_TIMEOUT_MS, 3000);
});

const GOLDEN: readonly (readonly [Message, string])[] = [
  [{ kind: "Authenticate", tag: "ff" }, '{"Authenticate":"ff"}'],
  [{ kind: "Hello", port: 8000 }, '{"Hello":8000}'],
  [{ kind: "Accept", id: UUID }, `{"Accept":"${UUID}"}`],
  [{ kind: "Challenge", id: UUID }, `{"Challenge":"${UUID}"}`],
  [{ kind: "Hello", port: 41234 }, '{"Hello":41234}'],
  [{ kind: "Heartbeat" }, '"Heartbeat"'],
  [{ kind: "Connection", id: UUID }, `{"Connection":"${UUID}"}`],
  [{ kind: "Error", message: "port already in use" }, '{"Error":"port already in use"}'],
];

test("encodeMessage matches serde's externally tagged representation", () => {
  for (const [message, json] of GOLDEN) {
    assert.equal(encodeMessage(message), json);
  }
});

test("Heartbeat is a bare JSON string, not an object", () => {
  assert.equal(encodeMessage({ kind: "Heartbeat" }), '"Heartbeat"');
  assert.deepEqual(parseServerMessage("Heartbeat"), { kind: "Heartbeat" });
  assert.throws(() => parseServerMessage({ Heartbeat: null }), ProtocolError);
});

test("round-trips through the parsers", () => {
  assert.deepEqual(parseClientMessage(JSON.parse('{"Authenticate":"ff"}')), {
    kind: "Authenticate",
    tag: "ff",
  });
  assert.deepEqual(parseClientMessage(JSON.parse('{"Hello":8000}')), { kind: "Hello", port: 8000 });
  assert.deepEqual(parseClientMessage(JSON.parse(`{"Accept":"${UUID}"}`)), {
    kind: "Accept",
    id: UUID,
  });
  assert.deepEqual(parseServerMessage(JSON.parse(`{"Challenge":"${UUID}"}`)), {
    kind: "Challenge",
    id: UUID,
  });
  assert.deepEqual(parseServerMessage(JSON.parse(`{"Connection":"${UUID}"}`)), {
    kind: "Connection",
    id: UUID,
  });
  assert.deepEqual(parseServerMessage(JSON.parse('{"Error":"nope"}')), {
    kind: "Error",
    message: "nope",
  });
});

test("parsers reject cross-enum and malformed payloads", () => {
  assert.throws(() => parseClientMessage("Heartbeat"), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.parse('{"Challenge":"' + UUID + '"}')), ProtocolError);
  assert.throws(() => parseServerMessage(JSON.parse('{"Accept":"' + UUID + '"}')), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.parse('{"Hello":70000}')), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.parse('{"Hello":-1}')), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.parse('{"Hello":1.5}')), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.parse('{"Hello":"8000"}')), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.parse('{"Accept":"not-a-uuid"}')), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.parse("[1,2]")), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.parse("{}")), ProtocolError);
  assert.throws(
    () => parseClientMessage(JSON.parse('{"Hello":1,"Accept":"' + UUID + '"}')),
    ProtocolError,
  );
});

test("parseUuid accepts the forms uuid::Uuid does", () => {
  assert.equal(parseUuid(UUID.toUpperCase()), UUID);
  assert.equal(parseUuid("b0f7f6cce1de4a0da1cf4e8f2b6f3c9a"), UUID);
  assert.equal(parseUuid(`urn:uuid:${UUID}`), UUID);
  assert.equal(parseUuid(`{${UUID}}`), UUID);
  assert.throws(() => parseUuid(42), ProtocolError);
});

test("Delimited round-trips every message over a byte-starved pipe", async () => {
  const [a, b] = duplexPair(8);
  const tx = new Delimited(a);
  const rx = new Delimited(b);

  // The 8-byte pipe holds far less than the whole batch, so sending and
  // receiving must overlap or both halves block forever -- exactly as they
  // would with `tokio::io::duplex(8)`.
  await Promise.all([
    (async () => {
      for (const [message] of GOLDEN) {
        await tx.send(message);
      }
    })(),
    (async () => {
      for (const [message] of GOLDEN) {
        const parse =
          "kind" in message && isServerKind(message.kind) ? parseServerMessage : parseClientMessage;
        assert.deepEqual(await rx.recv(parse as (value: unknown) => unknown), message);
      }
    })(),
  ]);
});

function isServerKind(kind: string): boolean {
  return kind === "Challenge" || kind === "Heartbeat" || kind === "Connection" || kind === "Error";
}

test("frames are terminated by a single NUL byte", async () => {
  const [a, b] = duplexPair(1024);
  const tx = new Delimited(a);
  const reader = new StreamReader(b);
  await tx.send({ kind: "Hello", port: 8000 });
  const bytes = await reader.readExact('{"Hello":8000}'.length + 1);
  assert.equal(bytes.toString("utf8"), '{"Hello":8000}\u0000');
});

test("a payload of exactly MAX_FRAME_LENGTH bytes is still valid", async () => {
  const [a, b] = duplexPair(1024);
  const rx = new Delimited(b);
  const message = `{"Error":"${"x".repeat(MAX_FRAME_LENGTH - 12)}"}`;
  assert.equal(message.length, MAX_FRAME_LENGTH);
  await writeAll(a, Buffer.concat([Buffer.from(message), Buffer.of(0)]));
  const parsed = await rx.recv(parseServerMessage);
  assert.deepEqual(parsed, { kind: "Error", message: "x".repeat(MAX_FRAME_LENGTH - 12) });
});

test("a payload longer than MAX_FRAME_LENGTH is rejected", async () => {
  const [a, b] = duplexPair(1024);
  const rx = new Delimited(b);
  const pending = rx.recv(parseServerMessage);
  await writeAll(a, Buffer.alloc(MAX_FRAME_LENGTH + 1, 42));
  await assert.rejects(pending, FrameError);
});

test("an over-long payload is rejected even when it contains a late delimiter", async () => {
  const [a, b] = duplexPair(1024);
  const rx = new Delimited(b);
  const pending = rx.recv(parseServerMessage);
  // Syntactically valid JSON, but padded so the NUL lands past the codec's
  // `max_length + 1` search window. tokio-util never sees the delimiter and
  // reports a length error; so must we.
  const padded = `{"Hello":${" ".repeat(MAX_FRAME_LENGTH + 44)}41234}`;
  assert.ok(padded.length > MAX_FRAME_LENGTH + 1);
  await writeAll(a, Buffer.concat([Buffer.from(padded), Buffer.of(0)]));
  await assert.rejects(pending, FrameError);
});

test("a delimiter at the very edge of the search window is still honoured", async () => {
  const [a, b] = duplexPair(1024);
  const rx = new Delimited(b);
  const message = `{"Error":"${"x".repeat(MAX_FRAME_LENGTH - 12)}"}`;
  assert.equal(message.length, MAX_FRAME_LENGTH);
  const pending = rx.recv(parseServerMessage);
  await writeAll(a, Buffer.concat([Buffer.from(message), Buffer.of(0), Buffer.alloc(64, 42)]));
  assert.deepEqual(await pending, { kind: "Error", message: "x".repeat(MAX_FRAME_LENGTH - 12) });
});

test("recv resolves with null at EOF", async () => {
  const [a, b] = duplexPair(1024);
  const rx = new Delimited(b);
  a.end();
  assert.equal(await rx.recv(parseServerMessage), null);
});

test("recv rejects on invalid JSON", async () => {
  const [a, b] = duplexPair(1024);
  const rx = new Delimited(b);
  await writeAll(a, Buffer.from("not json\u0000"));
  await assert.rejects(rx.recv(parseServerMessage), ProtocolError);
});

test("recvTimeout gives up after NETWORK_TIMEOUT", async () => {
  const [, b] = duplexPair(1024);
  const rx = new Delimited(b);
  const started = Date.now();
  await assert.rejects(rx.recvTimeout(parseServerMessage), TimeoutError);
  assert.ok(Date.now() - started >= NETWORK_TIMEOUT_MS - 100);
});

test("intoParts hands over every byte read past the last consumed frame", async () => {
  const [a, b] = duplexPair(4096);
  const rx = new Delimited(b);

  // One control frame, one buffered frame and a partial trailer, all in a
  // single TCP segment: exactly the situation `FramedParts::read_buf` covers.
  const payload = Buffer.concat([
    Buffer.from('{"Hello":8000}\u0000'),
    Buffer.from(`{"Connection":"${UUID}"}\u0000`),
    Buffer.from("raw proxied bytes"),
  ]);
  await writeAll(a, payload);

  assert.deepEqual(await rx.recv(parseServerMessage), { kind: "Hello", port: 8000 });
  // Let the decoder pull in the remainder before we detach.
  await new Promise((resolve) => setTimeout(resolve, 20));

  const parts = rx.intoParts();
  assert.equal(
    parts.readBuf.toString("utf8"),
    `{"Connection":"${UUID}"}\u0000raw proxied bytes`,
  );
});

test("copyBidirectional proxies both directions and propagates half-close", async () => {
  const [a1, a2] = duplexPair(4096);
  const [b1, b2] = duplexPair(4096);
  const copying = copyBidirectional(a2, b1);

  const left = new StreamReader(a1);
  const right = new StreamReader(b2);

  await writeAll(a1, "ping");
  assert.equal((await right.readExact(4)).toString(), "ping");

  await writeAll(b2, "pong");
  assert.equal((await left.readExact(4)).toString(), "pong");

  // Half-close one side: the peer must see EOF but stay writable.
  a1.end();
  assert.equal((await right.read()).length, 0);
  await writeAll(b2, "after half close");
  assert.equal((await left.readExact(16)).toString(), "after half close");

  b2.end();
  await copying;
});
