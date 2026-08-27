//! Port of `tests/e2e_test.rs`.
//!
//! Every test binds the fixed control port (7835), so they must not overlap.
//! `node --test` runs the tests inside one file sequentially, and the npm
//! script pins `--test-concurrency=1` so that files do not overlap either.
//! `Harness.dispose()` replaces the Rust behaviour of dropping the per-test
//! Tokio runtime, which is what releases the listener there.

import assert from "node:assert/strict";
import net from "node:net";
import test, { describe } from "node:test";

import { Client } from "../src/client.ts";
import { setWriter } from "../src/logger.ts";
import { STALE_CONNECTION_MS, Server } from "../src/server.ts";
import { CONTROL_PORT } from "../src/shared.ts";
import { Harness, StreamReader, accept, connect, delay, writeAll } from "./support.ts";

// `#[rstest] #[values(None, Some(""), Some("abc"))]` expands to `secret_1..3`.
// The case names are kept identical so parity tooling can pair them with the
// Rust originals; the argument each one stands for is spelled out below.
describe("basic_proxy", () => {
  for (const [index, secret] of [null, "", "abc"].entries()) {
    test(`secret_${index + 1}`, async () => {
      const h = new Harness();
      try {
        await h.spawnServer(secret);
        const { listener, port } = await h.spawnClient(secret);

        // The Rust test moves the listener into the task, so both the accepted
        // stream and the listener are dropped once the exchange finishes.
        const served = (async () => {
          const local = h.track(await accept(listener));
          const reader = new StreamReader(local);
          assert.equal((await reader.readExact(11)).toString(), "hello world");
          await writeAll(local, "I can send a message too!");
          local.end();
          listener.close();
        })();
        h.spawn(served);

        const stream = await h.connect(port);
        const reader = new StreamReader(stream);
        await writeAll(stream, "hello world");
        assert.equal((await reader.readExact(25)).toString(), "I can send a message too!");
        await served;

        // Ensure that the client end of the stream is closed now.
        assert.equal((await reader.read()).length, 0);

        // Also ensure that additional connections do not produce any data.
        const second = await h.connect(port);
        assert.equal((await new StreamReader(second).read()).length, 0);
      } finally {
        await h.dispose();
      }
    });
  }
});

// `#[case(None, Some("my secret"))]` and `#[case(Some("my secret"), None)]`
// expand to `case_1` and `case_2`; the names mirror rstest for parity tooling.
describe("mismatched_secret", () => {
  for (const [index, [serverSecret, clientSecret]] of (
    [
      [null, "my secret"],
      ["my secret", null],
    ] as const
  ).entries()) {
    test(`case_${index + 1}`, async () => {
      const h = new Harness();
      try {
        await h.spawnServer(serverSecret);
        await assert.rejects(h.spawnClient(clientSecret));
      } finally {
        await h.dispose();
      }
    });
  }
});

test("invalid_address", async () => {
  // We don't need a server for this test, so nothing binds the control port.
  const checkAddress = async (to: string, useSecret: boolean): Promise<void> => {
    await assert.rejects(
      Client.create("localhost", 5000, to, 0, useSecret ? "a secret" : null),
      `expected error for ${to}, useSecret=${useSecret}`,
    );
  };

  await Promise.all([
    checkAddress("google.com", false),
    checkAddress("google.com", true),
    checkAddress("nonexistent.domain.for.demonstration", false),
    checkAddress("nonexistent.domain.for.demonstration", true),
    checkAddress("malformed !$uri$%", false),
    checkAddress("malformed !$uri$%", true),
  ]);
});

test("very_long_frame", async () => {
  const h = new Harness();
  try {
    await h.spawnServer(null);
    const attacker = await h.connect(CONTROL_PORT, "localhost");
    let broken = false;
    attacker.on("error", () => {
      broken = true;
    });
    attacker.on("close", () => {
      broken = true;
    });

    // Slowly send a very long frame.
    for (let i = 0; i < 10; i += 1) {
      try {
        await writeAll(attacker, Buffer.alloc(100_000, 42));
      } catch {
        return;
      }
      if (broken) return;
      await delay(10);
    }
    assert.fail("did not exit after a 1 MB frame");
  } finally {
    await h.dispose();
  }
});

test("an oversized frame with a late delimiter is refused, not honoured", async () => {
  const h = new Harness();
  try {
    await h.spawnServer(null);
    const attacker = await h.connect(CONTROL_PORT, "localhost");
    const reader = new StreamReader(attacker);
    attacker.on("error", () => {});

    // A valid Hello, padded so its NUL falls outside the codec's search
    // window. Rust drops the connection; anything else means the server can be
    // talked into opening a tunnel with an over-long control frame.
    const payload = `{"Hello":${" ".repeat(300)}41234}`;
    await writeAll(attacker, Buffer.concat([Buffer.from(payload), Buffer.of(0)]));

    assert.equal((await reader.read()).length, 0, "server must not answer an over-long frame");
  } finally {
    await h.dispose();
  }
});

test("empty_port_range", () => {
  const minPort = 5000;
  const maxPort = 3000;
  assert.throws(() => new Server(minPort, maxPort, null), /must provide at least one port/);
});

test("half_closed_tcp_stream", async () => {
  // Check that "half-closed" TCP streams will not result in spontaneous hangups.
  const h = new Harness();
  try {
    await h.spawnServer(null);
    const { listener, port } = await h.spawnClient(null);

    const accepted = accept(listener);
    const cli = await h.connect(port);
    const srv = h.track(await accepted);

    const cliReader = new StreamReader(cli);
    const srvReader = new StreamReader(srv);

    // Send data before half-closing one of the streams.
    await writeAll(cli, "message before shutdown");

    // Only close the write half of the stream. This is a half-closed stream. In
    // the TCP protocol, it is represented as a FIN packet on one end. The entire
    // stream is only closed after two FINs are exchanged and ACKed.
    cli.end();

    assert.equal((await srvReader.readExact(23)).toString(), "message before shutdown");
    assert.equal((await srvReader.read()).length, 0); // EOF

    // Now make sure that the other stream can still send data, despite the
    // half-shutdown on the client -> server side.
    await writeAll(srv, "hello from the other side!");
    assert.equal((await cliReader.readExact(26)).toString(), "hello from the other side!");
  } finally {
    await h.dispose();
  }
});

test("requested port outside the allowed range is rejected", async () => {
  const h = new Harness();
  try {
    const server = new Server(20_000, 20_010, null);
    h.spawn(server.listen().catch(() => undefined));
    await delay(50);
    try {
      await assert.rejects(
        Client.create("localhost", 5000, "localhost", 1024, null),
        /server error: client port number not in allowed range/,
      );
    } finally {
      await server.close();
    }
  } finally {
    await h.dispose();
  }
});

test("a port already in use is reported verbatim", async () => {
  const h = new Harness();
  try {
    await h.spawnServer(null);
    // BSD sockets only raise EADDRINUSE for an identical address+port pair,
    // and tunnels bind 0.0.0.0.
    const blocker = h.trackListener(net.createServer());
    const occupied = await new Promise<number>((resolve) => {
      blocker.listen(0, "0.0.0.0", () => {
        const address = blocker.address();
        assert.ok(address !== null && typeof address === "object");
        resolve(address.port);
      });
    });
    await assert.rejects(
      Client.create("localhost", 5000, "localhost", occupied, null),
      /server error: port already in use/,
    );
  } finally {
    await h.dispose();
  }
});

test("an explicit remote port is honoured", async () => {
  const h = new Harness();
  try {
    await h.spawnServer(null);
    const { listener, port: localPort } = await h.listenLocal();
    // Grab a free port, release it, then ask the server for it.
    const probe = await h.listenLocal();
    const wanted = probe.port;
    await new Promise<void>((resolve) => probe.listener.close(() => resolve()));

    const client = await Client.create("localhost", localPort, "localhost", wanted, null);
    h.spawn(client.listen().catch(() => undefined));
    try {
      assert.equal(client.remotePort, wanted);

      const served = (async () => {
        const local = h.track(await accept(listener));
        local.pipe(local); // echo
      })();
      h.spawn(served);

      const stream = await h.connect(wanted);
      const reader = new StreamReader(stream);
      await writeAll(stream, "echo me");
      assert.equal((await reader.readExact(7)).toString(), "echo me");
    } finally {
      client.close();
    }
  } finally {
    await h.dispose();
  }
});

test("unclaimed connections are dropped and never leak", async () => {
  const h = new Harness();
  try {
    await h.spawnServer(null);
    const { listener, port } = await h.spawnClient(null);
    listener.close(); // nothing is listening locally any more

    const stream = await h.connect(port);
    // The client cannot reach the local service, so it tears the proxy down and
    // the public connection immediately sees EOF.
    assert.equal((await new StreamReader(stream).read()).length, 0);
  } finally {
    await h.dispose();
  }
});

test("a connection nobody claims is evicted after the stale timeout", async () => {
  const h = new Harness();
  const lines: string[] = [];
  setWriter((line) => void lines.push(line));
  try {
    await h.spawnServer(null);

    // A raw control connection: it asks for a tunnel and reads the `Connection`
    // announcement, but never sends `Accept`, so the server must discard the
    // pending socket after STALE_CONNECTION_MS.
    const control = h.track(await connect(CONTROL_PORT));
    const reader = new StreamReader(control);
    await writeAll(control, Buffer.from(`{"Hello":0}\0`));

    let port = 0;
    for (;;) {
      const frame = JSON.parse((await reader.readUntil(0)).toString()) as
        | string
        | Record<string, number>;
      if (typeof frame === "object" && "Hello" in frame) {
        port = frame["Hello"] as number;
        break;
      }
    }
    assert.ok(port >= 1024);

    const stranded = h.track(await connect(port));
    // The reader must be attached before the wait: it latches EOF from the
    // socket's events, which fire while we are sleeping.
    const strandedReader = new StreamReader(stranded);
    assert.equal(stranded.destroyed, false);

    await delay(STALE_CONNECTION_MS + 750);
    assert.ok(
      lines.some((line) => line.includes("removed stale connection")),
      `expected a stale-connection warning, got:\n${lines.join("")}`,
    );
    assert.equal((await strandedReader.read()).length, 0);
  } finally {
    setWriter(null);
    await h.dispose();
  }
});

test("the control listener reports a bind failure instead of hanging", async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(CONTROL_PORT, "127.0.0.1", resolve));
  const server = new Server(1024, 65535, null);
  server.setBindAddr("127.0.0.1");
  try {
    await assert.rejects(
      () => server.listen(),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, "EADDRINUSE");
        return true;
      },
    );
  } finally {
    await server.close();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("large payloads stream through without truncation", async () => {
  const h = new Harness();
  try {
    await h.spawnServer(null);
    const { listener, port } = await h.spawnClient(null);

    const size = 8 * 1024 * 1024;
    const payload = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) payload[i] = i & 0xff;

    const served = (async () => {
      const local = h.track(await accept(listener));
      await writeAll(local, payload);
      local.end();
    })();
    h.spawn(served);

    const stream = await h.connect(port);
    const received = await new StreamReader(stream).readExact(size);
    assert.equal(received.length, size);
    assert.ok(received.equals(payload));
    await served;
  } finally {
    await h.dispose();
  }
});

test("many concurrent connections are proxied independently", async () => {
  const h = new Harness();
  try {
    await h.spawnServer(null);
    const { listener, port } = await h.spawnClient(null);

    listener.on("connection", (socket: net.Socket) => {
      h.track(socket);
      socket.pipe(socket);
    });

    const count = 25;
    await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const socket = await h.connect(port);
        const reader = new StreamReader(socket);
        const message = `connection-${index}`;
        await writeAll(socket, message);
        assert.equal((await reader.readExact(message.length)).toString(), message);
      }),
    );
  } finally {
    await h.dispose();
  }
});

test("the control port is released once the server closes", async () => {
  const h = new Harness();
  try {
    const server = await h.spawnServer(null);
    await server.close();
    await delay(50);
    const listener = net.createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen({ host: "127.0.0.1", port: CONTROL_PORT }, () => resolve());
    });
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  } finally {
    await h.dispose();
  }
});

test("connecting to the control port without a hello times out cleanly", async () => {
  const h = new Harness();
  try {
    await h.spawnServer(null);
    const socket = await connect(CONTROL_PORT, "localhost");
    h.track(socket);
    const reader = new StreamReader(socket);
    // The server gives up after NETWORK_TIMEOUT and drops the connection.
    assert.equal((await reader.read()).length, 0);
  } finally {
    await h.dispose();
  }
});
