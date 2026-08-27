//! Transport stream with JSON frames delimited by null characters.
//!
//! Ported from `Delimited<U>` in `src/shared.rs`, which wraps
//! `tokio_util::codec::AnyDelimiterCodec::new_with_max_length(vec![0], vec![0], 256)`.
//!
//! Decoding semantics are reproduced exactly:
//!
//! * Frames are the bytes between `0x00` delimiters; the delimiter is stripped.
//! * A payload **longer than `MAX_FRAME_LENGTH`** with no delimiter in sight is
//!   a hard error (`MaxChunkLengthExceeded`), which propagates out of `recv()`
//!   and tears the connection down. A payload of exactly `MAX_FRAME_LENGTH`
//!   bytes is still valid.
//! * Encoding is deliberately *not* length-checked, matching `AnyDelimiterCodec`.
//!
//! The underlying stream is kept in **paused mode** (`readable` + `read()`) so
//! that `intoParts()` can hand ownership over without losing a single byte.
//!
//! Reading is strictly **demand driven**: bytes are pulled off the socket only
//! while a `recv()` is outstanding, exactly like a `Framed` that is only polled
//! from `next().await`. This matters for correctness, not just efficiency —
//! after a client sends `Accept`, the server immediately starts proxying raw
//! payload over the very same socket while the client is still dialling the
//! local service. An eager reader would swallow those bytes and trip the
//! `MAX_FRAME_LENGTH` guard, killing the tunnel.

import type { Duplex } from "node:stream";

import {
  MAX_FRAME_LENGTH,
  NETWORK_TIMEOUT_MS,
  ProtocolError,
  encodeMessage,
  type Message,
} from "./protocol.ts";
import { logger } from "./logger.ts";
import { ignoreErrors } from "./net.ts";

const log = logger("bore_cli::shared");

const DELIMITER = 0x00;
const EMPTY = Buffer.alloc(0);

/// Error raised when the codec gives up on an over-long frame, or when the
/// underlying transport fails mid-frame.
///
/// Both cases surface through `Framed`'s error type in Rust and are wrapped by
/// `.context("frame error, invalid byte length")`.
export class FrameError extends Error {
  constructor(message = "frame error, invalid byte length", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FrameError";
  }
}

/// Error raised when a handshake message does not arrive within the timeout.
export class TimeoutError extends Error {
  constructor(message = "timed out waiting for initial message") {
    super(message);
    this.name = "TimeoutError";
  }
}

interface Waiter {
  settled: boolean;
  resolve: (frame: Buffer | null) => void;
  reject: (error: Error) => void;
}

/// The buffers and transport recovered from a `Delimited`, mirroring
/// `tokio_util::codec::FramedParts`.
export interface DelimitedParts {
  /// The raw transport, still paused and free of `Delimited`'s listeners.
  readonly io: Duplex;
  /// Bytes that the decoder read past the last consumed frame. These are real
  /// payload and MUST be forwarded to the peer before raw copying begins.
  readonly readBuf: Buffer;
}

export class Delimited {
  readonly #io: Duplex;
  #buf: Buffer = EMPTY;
  #frames: Buffer[] = [];
  #waiters: Waiter[] = [];
  #ended = false;
  #failure: Error | null = null;
  #detached = false;

  readonly #onReadable = (): void => this.#pump();
  readonly #onEnd = (): void => {
    this.#ended = true;
    this.#flush();
  };
  readonly #onClose = (): void => {
    this.#ended = true;
    this.#flush();
  };
  readonly #onError = (error: Error): void => {
    this.#fail(new FrameError(undefined, { cause: error }));
  };

  /// Construct a new delimited stream.
  constructor(io: Duplex) {
    this.#io = io;
    io.on("readable", this.#onReadable);
    io.on("end", this.#onEnd);
    io.on("close", this.#onClose);
    io.on("error", this.#onError);
  }

  /// The underlying transport. Prefer `intoParts()` when taking ownership.
  get io(): Duplex {
    return this.#io;
  }

  #hasPendingWaiter(): boolean {
    return this.#waiters.some((waiter) => !waiter.settled);
  }

  #pump(): void {
    if (this.#detached) return;
    for (;;) {
      this.#flush();
      if (!this.#hasPendingWaiter()) return;
      if (this.#frames.length > 0) continue;
      const chunk: unknown = this.#io.read();
      if (chunk === null || chunk === undefined) return;
      this.#buf =
        this.#buf.length === 0 ? (chunk as Buffer) : Buffer.concat([this.#buf, chunk as Buffer]);
      try {
        this.#decode();
      } catch (error) {
        this.#fail(error as Error);
        return;
      }
    }
  }

  #decode(): void {
    for (;;) {
      // `AnyDelimiterCodec` only searches the first `max_length + 1` bytes, so
      // a delimiter sitting past that window does NOT rescue an over-long
      // frame -- it is still a length error. Scanning the whole buffer would
      // make this decoder strictly more permissive than Rust's on untrusted
      // control-port input.
      const readTo = Math.min(MAX_FRAME_LENGTH + 1, this.#buf.length);
      const index = this.#buf.subarray(0, readTo).indexOf(DELIMITER);
      if (index >= 0) {
        this.#frames.push(this.#buf.subarray(0, index));
        this.#buf = this.#buf.subarray(index + 1);
        continue;
      }
      if (this.#buf.length > MAX_FRAME_LENGTH) throw new FrameError();
      return;
    }
  }

  #flush(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters[0];
      if (waiter === undefined) break;
      if (waiter.settled) {
        this.#waiters.shift();
        continue;
      }
      const frame = this.#frames.shift();
      if (frame !== undefined) {
        this.#waiters.shift();
        waiter.settled = true;
        waiter.resolve(frame);
        continue;
      }
      if (this.#failure !== null) {
        this.#waiters.shift();
        waiter.settled = true;
        waiter.reject(this.#failure);
        continue;
      }
      if (this.#ended) {
        this.#waiters.shift();
        waiter.settled = true;
        waiter.resolve(null);
        continue;
      }
      break;
    }
  }

  #fail(error: Error): void {
    if (this.#failure !== null) return;
    this.#failure = error;
    this.#flush();
    if (!this.#io.destroyed) this.#io.destroy();
  }

  async #recvFrame(timeoutMs?: number): Promise<Buffer | null> {
    if (this.#detached) throw new Error("stream has already been detached");
    const buffered = this.#frames.shift();
    if (buffered !== undefined) return buffered;
    if (this.#failure !== null) throw this.#failure;
    if (this.#ended) return null;

    return await new Promise<Buffer | null>((resolve, reject) => {
      const waiter: Waiter = { settled: false, resolve, reject };
      this.#waiters.push(waiter);
      if (timeoutMs === undefined) {
        queueMicrotask(() => this.#pump());
        return;
      }
      const timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const at = this.#waiters.indexOf(waiter);
        if (at >= 0) this.#waiters.splice(at, 1);
        reject(new TimeoutError());
      }, timeoutMs);
      const clear = <T>(value: T): T => {
        clearTimeout(timer);
        return value;
      };
      waiter.resolve = (frame) => resolve(clear(frame));
      waiter.reject = (error) => reject(clear(error));
      queueMicrotask(() => this.#pump());
    });
  }

  /// Read the next null-delimited JSON instruction from a stream.
  async recv<T>(parse: (value: unknown) => T): Promise<T | null> {
    log.trace("waiting to receive json message");
    const frame = await this.#recvFrame();
    return frame === null ? null : decodeFrame(frame, parse);
  }

  /// Read the next null-delimited JSON instruction, with a default timeout.
  ///
  /// This is useful for parsing the initial message of a stream for handshake or
  /// other protocol purposes, where we do not want to wait indefinitely.
  async recvTimeout<T>(parse: (value: unknown) => T): Promise<T | null> {
    log.trace("waiting to receive json message");
    const frame = await this.#recvFrame(NETWORK_TIMEOUT_MS);
    return frame === null ? null : decodeFrame(frame, parse);
  }

  /// Send a null-terminated JSON instruction on a stream.
  async send(message: Message): Promise<void> {
    log.trace("sending json message");
    const json = Buffer.from(encodeMessage(message), "utf8");
    const payload = Buffer.concat([json, Buffer.of(DELIMITER)]);
    await new Promise<void>((resolve, reject) => {
      if (this.#io.destroyed || this.#io.writableEnded) {
        reject(new Error("connection closed"));
        return;
      }
      this.#io.write(payload, (error) => (error ? reject(error) : resolve()));
    });
  }

  /// Consume this object, returning current buffers and the inner transport.
  ///
  /// Any frames that were decoded but never delivered are re-serialised with
  /// their delimiters so that `readBuf` is byte-identical to what the Rust
  /// `FramedParts::read_buf` would have contained.
  intoParts(): DelimitedParts {
    if (this.#detached) throw new Error("stream has already been detached");
    this.#detached = true;
    this.#io.off("readable", this.#onReadable);
    this.#io.off("end", this.#onEnd);
    this.#io.off("close", this.#onClose);
    this.#io.off("error", this.#onError);

    const pieces: Buffer[] = [];
    for (const frame of this.#frames) {
      pieces.push(frame, Buffer.of(DELIMITER));
    }
    pieces.push(this.#buf);
    this.#frames = [];
    this.#buf = EMPTY;
    return { io: this.#io, readBuf: Buffer.concat(pieces) };
  }

  /// Whether the read half has already reached EOF.
  get readableEnded(): boolean {
    return this.#ended;
  }

  /// Close the underlying transport, mirroring `Delimited` being dropped.
  destroy(): void {
    if (this.#detached) return;
    this.#io.off("readable", this.#onReadable);
    this.#io.off("end", this.#onEnd);
    this.#io.off("close", this.#onClose);
    this.#io.off("error", this.#onError);
    ignoreErrors(this.#io);
    this.#detached = true;
    if (!this.#io.destroyed) this.#io.destroy();
  }
}

function decodeFrame<T>(frame: Buffer, parse: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(frame.toString("utf8"));
  } catch (error) {
    throw new ProtocolError(undefined, { cause: error });
  }
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError(undefined, { cause: error });
  }
}
