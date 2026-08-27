//! Server implementation for the `bore` service.
//!
//! Ported from `src/server.rs`.

import net from "node:net";
import { randomInt, randomUUID } from "node:crypto";

import { Authenticator } from "./auth.ts";
import { Delimited } from "./delimited.ts";
import { logger, withSpan } from "./logger.ts";
import { copyBidirectional, ignoreErrors, writeAll } from "./net.ts";
import { CONTROL_PORT, parseClientMessage } from "./protocol.ts";

const log = logger("bore_cli::server");

/// How long the accept loop waits before sending another heartbeat.
const ACCEPT_POLL_MS = 500;

/// How long a forwarded connection may sit unclaimed before it is dropped.
export const STALE_CONNECTION_MS = 10_000;

/// Number of random probes used when a client asks for an arbitrary port.
///
/// Estimated maximum amount of time to wait for the port allocation to succeed
/// is `-2 ln(delta) / epsilon`. With 150 tries this gives a 99.999% success
/// rate at 85% port utilisation (`epsilon = 0.15`, `delta = 0.00001`).
const PORT_PROBE_ATTEMPTS = 150;

/// A bind failure that is reported verbatim to the client.
export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindError";
  }
}

interface PendingConnection {
  readonly socket: net.Socket;
  readonly timer: NodeJS.Timeout;
}

/// Buffers sockets accepted on a tunnel listener so that the control loop can
/// poll them the way `tokio::time::timeout(_, listener.accept())` does.
class AcceptQueue {
  readonly #queue: net.Socket[] = [];
  #waiter: ((socket: net.Socket | null) => void) | null = null;

  push(socket: net.Socket): void {
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter(socket);
      return;
    }
    this.#queue.push(socket);
  }

  async next(timeoutMs: number): Promise<net.Socket | null> {
    const buffered = this.#queue.shift();
    if (buffered !== undefined) return buffered;
    return await new Promise<net.Socket | null>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#waiter === deliver) this.#waiter = null;
        resolve(null);
      }, timeoutMs);
      const deliver = (socket: net.Socket | null): void => {
        clearTimeout(timer);
        resolve(socket);
      };
      this.#waiter = deliver;
    });
  }

  dispose(): void {
    for (const socket of this.#queue) socket.destroy();
    this.#queue.length = 0;
    const waiter = this.#waiter;
    this.#waiter = null;
    if (waiter !== null) waiter(null);
  }
}

/// State structure for the server.
export class Server {
  readonly #minPort: number;
  readonly #maxPort: number;
  readonly #auth: Authenticator | null;
  readonly #conns = new Map<string, PendingConnection>();
  readonly #sockets = new Set<net.Socket>();
  readonly #listeners = new Set<net.Server>();

  #bindAddr = "0.0.0.0";
  #bindTunnels = "0.0.0.0";
  #control: net.Server | null = null;
  #binding: Promise<void> | null = null;
  #closed = false;

  /// Create a new server with a specified minimum port number.
  constructor(minPort: number, maxPort: number, secret?: string | null) {
    if (!(minPort <= maxPort)) throw new Error("must provide at least one port");
    this.#minPort = minPort;
    this.#maxPort = maxPort;
    this.#auth = secret === undefined || secret === null ? null : new Authenticator(secret);
  }

  /// Set the IP address where tunnels will listen on.
  ///
  /// (Kept identical to the Rust source, including its swapped doc comments:
  /// `set_bind_addr` actually configures the control listener.)
  setBindAddr(bindAddr: string): void {
    this.#bindAddr = bindAddr;
  }

  /// Set the IP address to bind to.
  setBindTunnels(bindTunnels: string): void {
    this.#bindTunnels = bindTunnels;
  }

  /// Start the server, listening for new connections.
  ///
  /// Resolves only once {@link close} is called; the Rust original loops
  /// forever because the process is expected to be killed instead.
  async listen(): Promise<void> {
    if (this.#closed) return;
    const control = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
    this.#control = control;

    const bound = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        control.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        control.off("error", onError);
        resolve();
      };
      control.once("error", onError);
      control.once("listening", onListening);
      control.listen({ host: this.#bindAddr, port: CONTROL_PORT });
    });
    this.#binding = bound.then(
      () => undefined,
      () => undefined,
    );
    await bound;

    if (this.#closed) return;

    log.info("server listening", { addr: this.#bindAddr });

    control.on("connection", (socket) => {
      this.#track(socket);
      void this.#spawnConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      if (this.#closed || !control.listening) {
        resolve();
        return;
      }
      control.once("close", resolve);
      control.once("error", reject);
    });
  }

  /// Shut the server down and release every socket it owns.
  ///
  /// Not present in the Rust original, where dropping the Tokio runtime frees
  /// the listener; Node has no equivalent, and tests need deterministic
  /// teardown of the fixed control port.
  async close(): Promise<void> {
    this.#closed = true;
    for (const pending of this.#conns.values()) {
      clearTimeout(pending.timer);
      pending.socket.destroy();
    }
    this.#conns.clear();
    for (const listener of this.#listeners) listener.close();
    this.#listeners.clear();
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();

    const control = this.#control;
    const binding = this.#binding;
    this.#control = null;
    this.#binding = null;
    if (control === null) return;

    // `close()` may land while the control listener is still binding. Closing a
    // server that has not bound yet is a no-op that leaves the port held, so
    // wait for the bind attempt to settle either way before tearing it down.
    if (binding !== null) await binding;
    if (!control.listening) return;
    await new Promise<void>((resolve) => control.close(() => resolve()));
  }

  #track(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.once("close", () => this.#sockets.delete(socket));
  }

  async #spawnConnection(socket: net.Socket): Promise<void> {
    const addr = `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`;
    await withSpan("control", { addr }, async () => {
      log.info("incoming connection");
      try {
        await this.#handleConnection(socket);
        log.info("connection exited");
      } catch (error) {
        log.warn("connection exited with error", { err: describe(error) });
      } finally {
        if (!socket.destroyed) socket.destroy();
      }
    });
  }

  async #handleConnection(socket: net.Socket): Promise<void> {
    const stream = new Delimited(socket);
    const auth = this.#auth;
    if (auth !== null) {
      try {
        await auth.serverHandshake(stream);
      } catch (error) {
        log.warn("server handshake failed", { err: describe(error) });
        await stream.send({ kind: "Error", message: describe(error) });
        return;
      }
    }

    const message = await stream.recvTimeout(parseClientMessage);
    if (message === null) return;
    switch (message.kind) {
      case "Authenticate":
        log.warn("unexpected authenticate");
        return;
      case "Hello":
        await this.#handleHello(stream, message.port);
        return;
      case "Accept":
        await this.#handleAccept(stream, message.id);
        return;
    }
  }

  async #handleHello(stream: Delimited, requestedPort: number): Promise<void> {
    let listener: net.Server;
    try {
      listener = await this.#createListener(requestedPort);
    } catch (error) {
      await stream.send({ kind: "Error", message: describe(error) });
      return;
    }

    const queue = new AcceptQueue();
    listener.on("connection", (socket) => queue.push(socket));
    this.#listeners.add(listener);

    const address = listener.address() as net.AddressInfo;
    const port = address.port;
    log.info("new client", { host: address.address, port });

    try {
      await stream.send({ kind: "Hello", port });
      while (!this.#closed) {
        try {
          await stream.send({ kind: "Heartbeat" });
        } catch {
          // Assume that the client is no longer reachable and stop.
          return;
        }
        const incoming = await queue.next(ACCEPT_POLL_MS);
        if (incoming === null) continue;
        this.#offerConnection(incoming, port);
        const id = this.#registerConnection(incoming);
        await stream.send({ kind: "Connection", id });
      }
    } finally {
      listener.close();
      queue.dispose();
      this.#listeners.delete(listener);
    }
  }

  #offerConnection(socket: net.Socket, port: number): void {
    log.info("new connection", {
      addr: `${socket.remoteAddress ?? "unknown"}:${socket.remotePort ?? 0}`,
      port,
    });
    ignoreErrors(socket);
  }

  #registerConnection(socket: net.Socket): string {
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (this.#conns.delete(id)) {
        log.warn("removed stale connection", { id });
        socket.destroy();
      }
    }, STALE_CONNECTION_MS);
    timer.unref();
    this.#conns.set(id, { socket, timer });
    return id;
  }

  async #handleAccept(stream: Delimited, id: string): Promise<void> {
    log.info("forwarding connection", { id });
    const pending = this.#conns.get(id);
    if (pending === undefined) {
      log.warn("missing connection", { id });
      return;
    }
    this.#conns.delete(id);
    clearTimeout(pending.timer);

    const parts = stream.intoParts();
    if (parts.io.writableLength !== 0) {
      throw new Error("framed write buffer not empty");
    }
    await writeAll(pending.socket, parts.readBuf);
    await copyBidirectional(parts.io, pending.socket);
  }

  async #createListener(port: number): Promise<net.Server> {
    if (port > 0) {
      if (port < this.#minPort || port > this.#maxPort) {
        throw new BindError("client port number not in allowed range");
      }
      return await this.#tryBind(port);
    }
    for (let attempt = 0; attempt < PORT_PROBE_ATTEMPTS; attempt += 1) {
      const candidate = randomInt(this.#minPort, this.#maxPort + 1);
      try {
        return await this.#tryBind(candidate);
      } catch {
        continue;
      }
    }
    throw new BindError("failed to find an available port");
  }

  #tryBind(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const listener = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
      const onError = (error: NodeJS.ErrnoException): void => {
        listener.off("listening", onListening);
        listener.close();
        reject(new BindError(mapBindError(error)));
      };
      const onListening = (): void => {
        listener.off("error", onError);
        ignoreErrors(listener);
        resolve(listener);
      };
      listener.once("error", onError);
      listener.once("listening", onListening);
      listener.listen({ host: this.#bindTunnels, port });
    });
  }
}

/// Maps a libuv errno onto the exact strings produced by `src/server.rs`.
const BIND_ERRORS = new Map<string, string>([
  ["EADDRINUSE", "port already in use"],
  ["EACCES", "permission denied"],
  ["EPERM", "permission denied"],
]);

const BIND_ERROR_FALLBACK = "failed to bind to port";

function mapBindError(error: NodeJS.ErrnoException): string {
  return BIND_ERRORS.get(error.code ?? "") ?? BIND_ERROR_FALLBACK;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
