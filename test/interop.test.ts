import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import test from "node:test";

import { Client } from "../src/client.ts";
import { Server } from "../src/server.ts";
import { StreamReader, connect, delay, writeAll } from "./support.ts";

import {
  CLEAN_ENV,
  HAS_RUST,
  JS_BIN,
  RUST_BIN,
  capture,
  normalize,
} from "./cli-support.ts";

/// Declaring nothing beats declaring skips: a skipped test still shows up as
/// "not passing" in strict CI reports, and `cli-golden.test.ts` already covers
/// the CLI surface without a Rust toolchain.
const interopTest: typeof test = HAS_RUST
  ? test
  : ((() => Promise.resolve()) as unknown as typeof test);

class Process {
  readonly #child: ChildProcessWithoutNullStreams;
  #output = "";
  readonly #watchers = new Set<(text: string) => void>();

  constructor(command: string, args: string[]) {
    this.#child = spawn(command, args, { env: CLEAN_ENV });
    // `tracing` logs land on stdout while `anyhow` failures land on stderr, so
    // both streams are merged before matching.
    const absorb = (chunk: string): void => {
      this.#output += chunk;
      for (const watcher of this.#watchers) watcher(this.#output);
    };
    this.#child.stdout.setEncoding("utf8").on("data", absorb);
    this.#child.stderr.setEncoding("utf8").on("data", absorb);
  }

  async waitFor(pattern: RegExp, timeoutMs = 10_000): Promise<RegExpMatchArray> {
    const existing = this.#output.match(pattern);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`timed out waiting for ${pattern}; output was:\n${this.#output}`));
      }, timeoutMs);
      const watcher = (text: string): void => {
        const match = text.match(pattern);
        if (!match) return;
        finish();
        resolve(match);
      };
      const finish = (): void => {
        clearTimeout(timer);
        this.#watchers.delete(watcher);
      };
      this.#watchers.add(watcher);
    });
  }

  async kill(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.#child.once("close", () => resolve()));
    this.#child.kill("SIGKILL");
    await exited;
  }
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.pipe(socket);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address !== null && typeof address === "object");
      resolve({
        port: address.port,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

async function roundTrip(port: number, payload: string): Promise<string> {
  const socket = await connect(port);
  try {
    const reader = new StreamReader(socket);
    await writeAll(socket, Buffer.from(payload));
    return (await reader.readExact(Buffer.byteLength(payload))).toString();
  } finally {
    socket.destroy();
  }
}

const CLI_CASES: string[][] = [
  [],
  ["--help"],
  ["-h"],
  ["--version"],
  ["-V"],
  ["help"],
  ["help", "local"],
  ["help", "server"],
  ["local", "--help"],
  ["server", "--help"],
  ["bogus"],
  ["local"],
  ["local", "3000"],
  ["local", "3000", "-t", "x", "extra"],
  ["local", "70000", "-t", "x"],
  ["local", "abc", "-t", "x"],
  ["local", " 5", "-t", "x"],
  ["local", "99999999999999999999", "-t", "x"],
  ["local", "1", "-t"],
  ["local", "--", "-1", "-t", "x"],
  ["server", "--nope"],
  ["server", "--bind-addr", "zzz"],
  ["server", "--min-port", "5000", "--max-port", "3000"],
  ["server", "--min-port", "abc"],
];

interopTest("the CLI surface is byte-identical to the reference implementation", async (t) => {
  for (const args of CLI_CASES) {
    await t.test(`bore ${args.join(" ")}`, async () => {
      const [rust, js] = await Promise.all([
        capture(RUST_BIN, args),
        capture(process.execPath, [JS_BIN, ...args]),
      ]);
      assert.equal(normalize(js.stdout), rust.stdout);
      assert.equal(normalize(js.stderr), rust.stderr);
      assert.equal(js.code, rust.code);
    });
  }
});

for (const secret of [null, "", "an interop secret"]) {
  const label = secret === null ? "no secret" : secret === "" ? "an empty secret" : "a secret";

  interopTest(`a JavaScript client tunnels through a Rust server with ${label}`, async () => {
    const echo = await echoServer();
    const remotePort = await freePort();
    const server = new Process(RUST_BIN, [
      "server",
      "--min-port",
      String(remotePort),
      "--max-port",
      String(remotePort),
      ...(secret === null ? [] : ["--secret", secret]),
    ]);
    let client: Client | null = null;
    try {
      await server.waitFor(/server listening/);
      client = await Client.create("127.0.0.1", echo.port, "127.0.0.1", remotePort, secret);
      assert.equal(client.remotePort, remotePort);
      const listening = client.listen();
      listening.catch(() => {});

      assert.equal(await roundTrip(remotePort, "hello from javascript"), "hello from javascript");
      assert.equal(await roundTrip(remotePort, "and again"), "and again");
      const big = "x".repeat(200_000);
      assert.equal(await roundTrip(remotePort, big), big);
    } finally {
      client?.close();
      await server.kill();
      await echo.close();
      await delay(25);
    }
  });

  interopTest(`a Rust client tunnels through a JavaScript server with ${label}`, async () => {
    const echo = await echoServer();
    const remotePort = await freePort();
    const server = new Server(remotePort, remotePort, secret);
    const listening = server.listen();
    listening.catch(() => {});
    await delay(50);

    const client = new Process(RUST_BIN, [
      "local",
      String(echo.port),
      "--local-host",
      "127.0.0.1",
      "--to",
      "127.0.0.1",
      "--port",
      String(remotePort),
      ...(secret === null ? [] : ["--secret", secret]),
    ]);
    try {
      await client.waitFor(new RegExp(`listening at 127\\.0\\.0\\.1:${remotePort}`));

      assert.equal(await roundTrip(remotePort, "hello from rust"), "hello from rust");
      assert.equal(await roundTrip(remotePort, "and again"), "and again");
      const big = "y".repeat(200_000);
      assert.equal(await roundTrip(remotePort, big), big);
    } finally {
      await client.kill();
      await server.close();
      await echo.close();
      await delay(25);
    }
  });
}

interopTest("a Rust client is rejected by a JavaScript server with a different secret", async () => {
  const remotePort = await freePort();
  const server = new Server(remotePort, remotePort, "server secret");
  const listening = server.listen();
  listening.catch(() => {});
  await delay(50);

  const client = new Process(RUST_BIN, [
    "local",
    "3000",
    "--to",
    "127.0.0.1",
    "--secret",
    "client secret",
  ]);
  try {
    await client.waitFor(/server error: invalid secret/);
  } finally {
    await client.kill();
    await server.close();
    await delay(25);
  }
});

interopTest("a JavaScript client is rejected by a Rust server with a different secret", async () => {
  const server = new Process(RUST_BIN, ["server", "--secret", "server secret"]);
  try {
    await server.waitFor(/server listening/);
    await assert.rejects(
      Client.create("127.0.0.1", 3000, "127.0.0.1", 0, "client secret"),
      /server error: invalid secret/,
    );
  } finally {
    await server.kill();
    await delay(25);
  }
});

interopTest("a Rust server reports its port errors to a JavaScript client", async () => {
  const server = new Process(RUST_BIN, ["server", "--min-port", "20000", "--max-port", "20010"]);
  try {
    await server.waitFor(/server listening/);
    await assert.rejects(
      Client.create("127.0.0.1", 3000, "127.0.0.1", 19999, null),
      /server error: client port number not in allowed range/,
    );
  } finally {
    await server.kill();
    await delay(25);
  }
});

interopTest("a JavaScript server reports its port errors to a Rust client", async () => {
  const server = new Server(20000, 20010, null);
  const listening = server.listen();
  listening.catch(() => {});
  await delay(50);

  const client = new Process(RUST_BIN, [
    "local",
    "3000",
    "--to",
    "127.0.0.1",
    "--port",
    "19999",
  ]);
  try {
    await client.waitFor(/server error: client port number not in allowed range/);
  } finally {
    await client.kill();
    await server.close();
    await delay(25);
  }
});
