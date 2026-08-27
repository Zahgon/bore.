//! Port of `tests/auth_test.rs`, plus golden vectors captured from the Rust
//! implementation itself (see `docs/MIGRATION.md`).

import assert from "node:assert/strict";
import test from "node:test";

import { Authenticator, uuidToBytes } from "../src/auth.ts";
import { Delimited } from "../src/delimited.ts";
import { duplexPair } from "./support.ts";

test("auth_handshake", async () => {
  const auth = new Authenticator("some secret string");

  // Ensure correctness with a limited capacity, mirroring `io::duplex(8)`.
  const [a, b] = duplexPair(8);
  const client = new Delimited(a);
  const server = new Delimited(b);

  await Promise.all([auth.clientHandshake(client), auth.serverHandshake(server)]);
});

test("auth_handshake_fail", async () => {
  const clientAuth = new Authenticator("client secret");
  const serverAuth = new Authenticator("different server secret");

  const [a, b] = duplexPair(8);
  const client = new Delimited(a);
  const server = new Delimited(b);

  await assert.rejects(
    Promise.all([clientAuth.clientHandshake(client), serverAuth.serverHandshake(server)]),
    /invalid secret/,
  );
});

test("client handshake fails when the server never challenges", async () => {
  const auth = new Authenticator("secret");
  const [a, b] = duplexPair(8);
  const client = new Delimited(a);
  const server = new Delimited(b);

  // The server acts as though no secret were configured and greets first.
  await server.send({ kind: "Hello", port: 1234 });

  await assert.rejects(
    auth.clientHandshake(client),
    /expected authentication challenge, but no secret was required/,
  );
});

test("server handshake rejects a client that skips authentication", async () => {
  const auth = new Authenticator("secret");
  const [a, b] = duplexPair(8);
  const client = new Delimited(a);
  const server = new Delimited(b);

  const handshake = auth.serverHandshake(server);
  await client.recv((value) => value); // consume the challenge
  await client.send({ kind: "Hello", port: 0 });

  await assert.rejects(handshake, /server requires secret, but no secret was provided/);
});

test("uuidToBytes produces the 16 raw bytes of the UUID", () => {
  assert.equal(
    uuidToBytes("b0f7f6cc-e1de-4a0d-a1cf-4e8f2b6f3c9a").toString("hex"),
    "b0f7f6cce1de4a0da1cf4e8f2b6f3c9a",
  );
  assert.equal(uuidToBytes("00000000-0000-0000-0000-000000000000").length, 16);
});

// Captured by linking against the real `bore-cli` crate and printing
// `Authenticator::new(secret).answer(&challenge)`.
const GOLDEN_ANSWERS: readonly (readonly [string, string, string])[] = [
  [
    "",
    "00000000-0000-0000-0000-000000000000",
    "d12735575423a0e7f53a6191fd5ffe258d92297e771ff55f4ba8e4672bf05aba",
  ],
  [
    "abc",
    "00000000-0000-0000-0000-000000000000",
    "4fc5de8656c9bff277dc567838734f55309f363059f228ec14ab2506ab8793a8",
  ],
  [
    "some secret string",
    "b0f7f6cc-e1de-4a0d-a1cf-4e8f2b6f3c9a",
    "81150da8f594222a1dcbfb321224028daa5437a3b0a0dc8179f610f69634ce58",
  ],
  [
    "my secret",
    "0192d4b3-1f7e-7a5c-9f2a-3b4c5d6e7f80",
    "5caac648cca8d465d99d5636462aba66cafda5b3a12f78c3d0f2f140e7852c7c",
  ],
];

test("answer matches golden vectors from the Rust implementation", () => {
  for (const [secret, challenge, expected] of GOLDEN_ANSWERS) {
    const auth = new Authenticator(secret);
    assert.equal(auth.answer(challenge), expected, `secret=${JSON.stringify(secret)}`);
    assert.equal(auth.validate(challenge, expected), true);
  }
});

test("validate rejects malformed and mismatched tags", () => {
  // From the doc-test in `src/auth.rs`.
  const auth = new Authenticator("secret");
  const challenge = "b0f7f6cc-e1de-4a0d-a1cf-4e8f2b6f3c9a";
  assert.equal(auth.validate(challenge, auth.answer(challenge)), true);
  assert.equal(auth.validate(challenge, "wrong answer"), false);

  assert.equal(auth.validate(challenge, ""), false);
  assert.equal(auth.validate(challenge, "abc"), false, "odd length is invalid hex");
  assert.equal(auth.validate(challenge, "zz"), false, "non-hex digits are invalid");
  assert.equal(auth.validate(challenge, "00"), false, "correct hex but wrong length");
  // A different challenge must not validate.
  assert.equal(auth.validate("00000000-0000-0000-0000-000000000000", auth.answer(challenge)), false);
});

test("the empty secret is still a secret", () => {
  const auth = new Authenticator("");
  const challenge = "00000000-0000-0000-0000-000000000000";
  assert.notEqual(auth.answer(challenge), new Authenticator("x").answer(challenge));
});
