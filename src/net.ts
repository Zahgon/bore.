//! Socket helpers that stand in for the `tokio::net` / `tokio::io` primitives
//! used by `bore`.
//!
//! Three behaviours matter for functional equivalence:
//!
//! 1. **Half-open support.** `tokio::io::copy_bidirectional` shuts down only the
//!    write half of the peer when one direction reaches EOF, and keeps copying
//!    the other direction until it too finishes. Node sockets destroy
//!    themselves on FIN unless created with `allowHalfOpen: true`, so every
//!    socket in this port opts in.
//! 2. **Backpressure.** `stream.pipe()` already honours the destination's
//!    `write()` return value, matching `copy_bidirectional`'s bounded buffer.
//! 3. **Connect timeouts.** `TcpStream::connect` wrapped in
//!    `tokio::time::timeout(NETWORK_TIMEOUT, ..)`.

import type { EventEmitter } from "node:events";
import net from "node:net";
import type { Duplex } from "node:stream";

import { NETWORK_TIMEOUT_MS } from "./protocol.ts";

/// Silences `error` events on a stream we have already given up on, mirroring
/// how dropping a `TcpStream` in Rust discards any pending error. Without this,
/// Node would escalate the event into an uncaught exception.
export function ignoreErrors(source: EventEmitter): void {
  source.on("error", () => {});
}

/// Attaches `message` as the top-level description while retaining the original
/// error as `cause`, mirroring `anyhow::Context`.
export function context(error: unknown, message: string): Error {
  return new Error(message, { cause: error });
}

/// Renders an error the way `anyhow`'s `Debug` impl does when returned from
/// `fn main`, i.e. the message followed by its `Caused by:` chain.
export function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  const head = messages[0] ?? "unknown error";
  const causes = messages.slice(1);
  if (causes.length === 0) return head;
  // anyhow only numbers the chain when there is more than one cause.
  const body =
    causes.length === 1
      ? `    ${causes[0] as string}`
      : causes.map((message, index) => `    ${index}: ${message}`).join("\n");
  return `${head}\n\nCaused by:\n${body}`;
}

/// Writes the whole buffer, resolving once it has been flushed to the OS.
export function writeAll(socket: Duplex, data: Buffer): Promise<void> {
  if (data.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => (error ? reject(error) : resolve()));
  });
}

/// `TcpStream::connect((to, port))` guarded by `NETWORK_TIMEOUT`.
///
/// Failures are wrapped with `could not connect to {to}:{port}`, exactly like
/// `connect_with_timeout` in `src/client.rs`.
export function connectWithTimeout(to: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket({ allowHalfOpen: true });
    let settled = false;

    const fail = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      ignoreErrors(socket);
      reject(context(cause, `could not connect to ${to}:${port}`));
    };

    const timer = setTimeout(() => fail(new Error("deadline has elapsed")), NETWORK_TIMEOUT_MS);

    socket.once("error", fail);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", fail);
      socket.setNoDelay(true);
      resolve(socket);
    });

    try {
      socket.connect({ host: to, port });
    } catch (error) {
      fail(error);
    }
  });
}

/// Copies data in both directions between two streams, propagating each
/// direction's EOF as a write-half shutdown on the peer.
///
/// Equivalent to `tokio::io::copy_bidirectional(&mut a, &mut b)`: it resolves
/// once both directions have completed, and rejects (after tearing both sides
/// down) if either side errors.
export function copyBidirectional(a: Duplex, b: Duplex): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let remaining = 2;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      destroyQuietly(a);
      destroyQuietly(b);
      reject(error);
    };

    const done = (): void => {
      if (settled) return;
      remaining -= 1;
      if (remaining === 0) {
        settled = true;
        resolve();
      }
    };

    a.on("error", fail);
    b.on("error", fail);
    a.on("close", done);
    b.on("close", done);

    half(a, b);
    half(b, a);
  });
}

/// Wires up one direction. If the source already hit EOF while it was owned by
/// a `Delimited`, `pipe()` would never observe the `end` event, so shut the
/// destination's write half down immediately instead.
function half(source: Duplex, destination: Duplex): void {
  if (source.readableEnded) {
    if (!destination.writableEnded && !destination.destroyed) destination.end();
    return;
  }
  source.pipe(destination);
}

function destroyQuietly(stream: Duplex): void {
  ignoreErrors(stream);
  if (!stream.destroyed) stream.destroy();
}
