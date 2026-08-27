//! Client implementation for the `bore` service.
//!
//! Ported from `src/client.rs`.

import type net from "node:net";

import { Authenticator } from "./auth.ts";
import { Delimited } from "./delimited.ts";
import { logger, withSpan } from "./logger.ts";
import { connectWithTimeout, copyBidirectional, writeAll } from "./net.ts";
import { CONTROL_PORT, parseServerMessage } from "./protocol.ts";

const log = logger("bore_cli::client");

/// State structure for the client.
export class Client {
  #conn: Delimited | null;
  readonly #to: string;
  readonly #localHost: string;
  readonly #localPort: number;
  readonly #remotePort: number;
  readonly #auth: Authenticator | null;
  readonly #sockets = new Set<net.Socket>();
  #closed = false;

  private constructor(init: {
    conn: Delimited;
    to: string;
    localHost: string;
    localPort: number;
    remotePort: number;
    auth: Authenticator | null;
  }) {
    this.#conn = init.conn;
    this.#to = init.to;
    this.#localHost = init.localHost;
    this.#localPort = init.localPort;
    this.#remotePort = init.remotePort;
    this.#auth = init.auth;
  }

  /// Create a new client, connecting to the remote control port.
  ///
  /// The Rust original is an async `Client::new`; JavaScript constructors
  /// cannot be asynchronous, so the fallible work lives in this factory.
  static async create(
    localHost: string,
    localPort: number,
    to: string,
    port: number,
    secret?: string | null,
  ): Promise<Client> {
    const auth = secret === undefined || secret === null ? null : new Authenticator(secret);
    const socket = await connectWithTimeout(to, CONTROL_PORT);
    const stream = new Delimited(socket);
    try {
      if (auth !== null) await auth.clientHandshake(stream);
      await stream.send({ kind: "Hello", port });

      const message = await stream.recvTimeout(parseServerMessage);
      if (message === null) throw new Error("unexpected EOF");
      let remotePort: number;
      switch (message.kind) {
        case "Hello":
          remotePort = message.port;
          break;
        case "Error":
          throw new Error(`server error: ${message.message}`);
        case "Challenge":
          throw new Error("server requires authentication, but no client secret was provided");
        default:
          throw new Error("unexpected initial non-hello message");
      }

      log.info("connected to server", { remote_port: remotePort });
      log.info(`listening at ${to}:${remotePort}`);
      return new Client({ conn: stream, to, localHost, localPort, remotePort, auth });
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  /// Returns the port publicly available on the remote.
  get remotePort(): number {
    return this.#remotePort;
  }

  /// Start the client, listening for new connections.
  async listen(): Promise<void> {
    const conn = this.#conn;
    this.#conn = null;
    if (conn === null) throw new Error("client is already listening");
    try {
      for (;;) {
        const message = await conn.recv(parseServerMessage);
        if (message === null) return;
        switch (message.kind) {
          case "Hello":
            log.warn("unexpected hello");
            break;
          case "Challenge":
            log.warn("unexpected challenge");
            break;
          case "Heartbeat":
            break;
          case "Connection":
            void this.#spawnConnection(message.id);
            break;
          case "Error":
            log.error("server error", { err: message.message });
            break;
        }
      }
    } finally {
      conn.destroy();
    }
  }

  /// Tear the client down, closing the control connection and every proxied
  /// socket. Not present in the Rust original, where dropping the runtime does
  /// the same job.
  close(): void {
    this.#closed = true;
    this.#conn?.destroy();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
  }

  #track(socket: net.Socket): void {
    if (this.#closed) {
      socket.destroy();
      return;
    }
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
  }

  async #spawnConnection(id: string): Promise<void> {
    await withSpan("proxy", { id }, async () => {
      log.info("new connection");
      try {
        await this.#handleConnection(id);
        log.info("connection exited");
      } catch (error) {
        log.warn("connection exited with error", {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async #handleConnection(id: string): Promise<void> {
    const remoteSocket = await connectWithTimeout(this.#to, CONTROL_PORT);
    this.#track(remoteSocket);
    const remoteConn = new Delimited(remoteSocket);

    let localSocket: net.Socket;
    try {
      if (this.#auth !== null) await this.#auth.clientHandshake(remoteConn);
      await remoteConn.send({ kind: "Accept", id });
      localSocket = await connectWithTimeout(this.#localHost, this.#localPort);
    } catch (error) {
      // Collapsing the control stream lets the server tear the public-facing
      // socket down, which is what callers observe as an immediate EOF.
      remoteConn.destroy();
      throw error;
    }
    this.#track(localSocket);

    const parts = remoteConn.intoParts();
    if (parts.io.writableLength !== 0) {
      throw new Error("framed write buffer not empty");
    }
    // In most of the cases, this will be empty.
    await writeAll(localSocket, parts.readBuf);
    await copyBidirectional(localSocket, parts.io);
  }
}
