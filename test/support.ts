//! Shared test utilities.
//!
//! These stand in for the Tokio primitives the Rust test-suite relies on:
//! `tokio::io::duplex(n)`, `AsyncReadExt::read_exact`, `AsyncReadExt::read`
//! and `tokio::spawn` + runtime teardown.

import net from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "../src/client.ts";
import { Server } from "../src/server.ts";

export { delay };

/// One half of an in-memory bidirectional pipe.
class PipeSide extends Duplex {
  readonly #rx: PassThrough;
  readonly #tx: PassThrough;
  #flowing = false;

  constructor(rx: PassThrough, tx: PassThrough, highWaterMark: number) {
    super({ allowHalfOpen: true, highWaterMark });
    this.#rx = rx;
    this.#tx = tx;
    rx.on("readable", () => this.#pump());
    rx.on("end", () => this.push(null));
    rx.on("error", (error: Error) => this.destroy(error));
  }

  #pump(): void {
    if (!this.#flowing) return;
    for (;;) {
      const chunk: unknown = this.#rx.read();
      if (chunk === null || chunk === undefined) return;
      if (!this.push(chunk)) {
        this.#flowing = false;
        return;
      }
    }
  }

  override _read(): void {
    this.#flowing = true;
    this.#pump();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.#tx.write(chunk)) {
      callback();
      return;
    }
    this.#tx.once("drain", () => callback());
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.#tx.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#tx.destroy();
    this.#rx.destroy();
    callback(error);
  }
}

/// Equivalent of `tokio::io::duplex(max_buf_size)`.
///
/// The Rust auth test deliberately uses a capacity of 8 bytes to prove that the
/// handshake is correct even when every frame is split across many chunks.
export function duplexPair(highWaterMark = 8): readonly [Duplex, Duplex] {
  const aToB = new PassThrough({ highWaterMark });
  const bToA = new PassThrough({ highWaterMark });
  return [new PipeSide(bToA, aToB, highWaterMark), new PipeSide(aToB, bToA, highWaterMark)];
}

/// Buffered reader offering `read_exact` / `read` semantics on a stream.
export class StreamReader {
  #buf: Buffer = Buffer.alloc(0);
  #ended = false;
  #error: Error | null = null;
  #wake: (() => void) | null = null;

  constructor(stream: Duplex) {
    stream.on("data", (chunk: Buffer) => {
      this.#buf = Buffer.concat([this.#buf, chunk]);
      this.#notify();
    });
    stream.on("end", () => {
      this.#ended = true;
      this.#notify();
    });
    stream.on("close", () => {
      this.#ended = true;
      this.#notify();
    });
    stream.on("error", (error: Error) => {
      this.#error = error;
      this.#ended = true;
      this.#notify();
    });
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    if (wake !== null) wake();
  }

  async #wait(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
  }

  /// Reads one delimiter-terminated frame, returning it without the delimiter.
  async readUntil(delimiter: number): Promise<Buffer> {
    for (;;) {
      const index = this.#buf.indexOf(delimiter);
      if (index >= 0) {
        const out = this.#buf.subarray(0, index);
        this.#buf = this.#buf.subarray(index + 1);
        return out;
      }
      if (this.#error !== null) throw this.#error;
      if (this.#ended) throw new Error("unexpected EOF while waiting for a delimiter");
      await this.#wait();
    }
  }

  /// `AsyncReadExt::read_exact`: fails if EOF arrives early.
  async readExact(length: number): Promise<Buffer> {
    while (this.#buf.length < length) {
      if (this.#error !== null) throw this.#error;
      if (this.#ended) {
        throw new Error(`unexpected EOF: wanted ${length}, have ${this.#buf.length}`);
      }
      await this.#wait();
    }
    const out = this.#buf.subarray(0, length);
    this.#buf = this.#buf.subarray(length);
    return out;
  }

  /// `AsyncReadExt::read`: resolves with however many bytes are available, or
  /// with an empty buffer at EOF (the `== 0` case in the Rust tests).
  async read(): Promise<Buffer> {
    while (this.#buf.length === 0 && !this.#ended) await this.#wait();
    if (this.#buf.length === 0 && this.#error !== null) throw this.#error;
    const out = this.#buf;
    this.#buf = Buffer.alloc(0);
    return out;
  }
}

export function writeAll(stream: Duplex, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

/// `TcpStream::connect(addr)` for the tests, with half-open support so that a
/// FIN from the peer does not tear our end down.
export function connect(port: number, host = "127.0.0.1"): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket({ allowHalfOpen: true });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.connect({ host, port });
  });
}

/// A `TcpListener` bound to an ephemeral loopback port.
export async function listenLocal(): Promise<{ listener: net.Server; port: number }> {
  const listener = net.createServer({ allowHalfOpen: true });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port: 0 }, () => {
      listener.off("error", reject);
      resolve();
    });
  });
  const address = listener.address() as net.AddressInfo;
  return { listener, port: address.port };
}

export function accept(listener: net.Server): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.once("connection", (socket) => {
      listener.off("error", reject);
      resolve(socket);
    });
  });
}

/// Everything a single end-to-end test owns, so that teardown is exhaustive.
///
/// Rust gets this for free: each `#[tokio::test]` drops its runtime, which
/// closes every socket the test opened, including the fixed control port.
export class Harness {
  readonly #servers: Server[] = [];
  readonly #clients: Client[] = [];
  readonly #listeners: net.Server[] = [];
  readonly #sockets: net.Socket[] = [];
  readonly #tasks: Promise<unknown>[] = [];

  /// Spawn the server, giving some time for the control port listener to start.
  async spawnServer(secret?: string | null): Promise<Server> {
    const server = new Server(1024, 65535, secret);
    this.#servers.push(server);
    this.#tasks.push(server.listen().catch(() => undefined));
    await delay(50);
    return server;
  }

  /// Spawns a client with randomly assigned ports, returning the listener and
  /// the remote port on the bore server.
  async spawnClient(
    secret?: string | null,
  ): Promise<{ listener: net.Server; port: number; client: Client }> {
    const { listener, port: localPort } = await this.listenLocal();
    const client = await Client.create("localhost", localPort, "localhost", 0, secret);
    this.#clients.push(client);
    this.#tasks.push(client.listen().catch(() => undefined));
    return { listener, port: client.remotePort, client };
  }

  async listenLocal(): Promise<{ listener: net.Server; port: number }> {
    const result = await listenLocal();
    this.#listeners.push(result.listener);
    return result;
  }

  trackListener<T extends net.Server>(listener: T): T {
    this.#listeners.push(listener);
    listener.on("error", () => {
      /* teardown races are expected */
    });
    return listener;
  }

  async connect(port: number, host = "127.0.0.1"): Promise<net.Socket> {
    const socket = await connect(port, host);
    this.track(socket);
    return socket;
  }

  track<T extends net.Socket>(socket: T): T {
    this.#sockets.push(socket);
    socket.on("error", () => {
      /* teardown races are expected */
    });
    return socket;
  }

  spawn(task: Promise<unknown>): void {
    this.#tasks.push(task);
  }

  async dispose(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    for (const client of this.#clients) client.close();
    for (const listener of this.#listeners) listener.close();
    for (const server of this.#servers) await server.close();
    await Promise.allSettled(this.#tasks);
    // Give libuv a tick to actually release the control port.
    await delay(25);
  }
}
