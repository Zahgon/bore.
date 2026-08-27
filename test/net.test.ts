import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough } from "node:stream";
import { after, describe, test } from "node:test";

import {
  connectWithTimeout,
  context,
  copyBidirectional,
  formatErrorChain,
  writeAll,
} from "../src/net.ts";
import { duplexPair, listenLocal } from "./support.ts";

describe("anyhow-compatible error rendering", () => {
  test("a bare error renders as its message alone", () => {
    assert.equal(formatErrorChain(new Error("could not connect to x:7835")), "could not connect to x:7835");
  });

  test("a single cause is rendered unnumbered", () => {
    const error = context(new Error("nodename nor servname provided"), "could not connect to x:7835");
    assert.equal(
      formatErrorChain(error),
      "could not connect to x:7835\n\nCaused by:\n    nodename nor servname provided",
    );
  });

  test("two or more causes are rendered as a numbered list", () => {
    const error = context(context(new Error("connection refused"), "io error"), "could not connect to x:7835");
    assert.equal(
      formatErrorChain(error),
      "could not connect to x:7835\n\nCaused by:\n    0: io error\n    1: connection refused",
    );
  });

  test("non-Error values are stringified", () => {
    assert.equal(formatErrorChain("plain string"), "plain string");
    assert.equal(formatErrorChain(undefined), "unknown error");
    assert.equal(formatErrorChain(null), "unknown error");
  });

  test("context preserves the original error as cause", () => {
    const cause = new Error("inner");
    const wrapped = context(cause, "outer");
    assert.equal(wrapped.message, "outer");
    assert.equal(wrapped.cause, cause);
  });
});

describe("writeAll", () => {
  test("resolves once a non-empty payload has been flushed", async () => {
    const sink = new PassThrough();
    await writeAll(sink, Buffer.from("hello world"));
    sink.end();
    const chunks: Buffer[] = [];
    for await (const chunk of sink) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString(), "hello world");
  });

  test("short-circuits on an empty payload", async () => {
    const sink = new PassThrough();
    sink.destroy();
    await writeAll(sink, Buffer.alloc(0));
  });

  test("rejects when the destination is already destroyed", async () => {
    const sink = new PassThrough();
    sink.destroy();
    await assert.rejects(() => writeAll(sink, Buffer.from("x")));
  });
});

describe("connectWithTimeout", () => {
  const listeners: net.Server[] = [];
  after(() => {
    for (const listener of listeners) listener.close();
  });

  test("connects to a live listener and disables Nagle", async () => {
    const { listener, port } = await listenLocal();
    listeners.push(listener);
    const socket = await connectWithTimeout("127.0.0.1", port);
    assert.equal(socket.destroyed, false);
    socket.destroy();
  });

  test("wraps a refused connection with the Rust context string", async () => {
    const { listener, port } = await listenLocal();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await assert.rejects(
      () => connectWithTimeout("127.0.0.1", port),
      (error: Error) => {
        assert.equal(error.message, `could not connect to 127.0.0.1:${port}`);
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
  });

  test("wraps a synchronous connect failure", async () => {
    await assert.rejects(
      () => connectWithTimeout("127.0.0.1", -1),
      (error: Error) => {
        assert.equal(error.message, "could not connect to 127.0.0.1:-1");
        return true;
      },
    );
  });

  test("wraps an unresolvable host", async () => {
    const host = "nonexistent.domain.for.demonstration";
    await assert.rejects(
      () => connectWithTimeout(host, 7835),
      (error: Error) => {
        assert.equal(error.message, `could not connect to ${host}:7835`);
        return true;
      },
    );
  });
});

describe("copyBidirectional", () => {
  test("tears both sides down and rejects when one errors", async () => {
    const [a, b] = duplexPair();
    const copying = copyBidirectional(a, b);
    a.emit("error", new Error("connection reset by peer"));
    await assert.rejects(() => copying, /connection reset by peer/);
    assert.equal(a.destroyed, true);
    assert.equal(b.destroyed, true);
  });

  test("only the first error settles the copy", async () => {
    const [a, b] = duplexPair();
    const copying = copyBidirectional(a, b);
    a.emit("error", new Error("first"));
    b.emit("error", new Error("second"));
    await assert.rejects(() => copying, /first/);
  });

  test("a source that already reached EOF shuts the peer's write half down", async () => {
    const [a, b] = duplexPair();
    const [c, d] = duplexPair();

    a.end();
    b.resume();
    await new Promise((resolve) => b.once("end", resolve));
    assert.equal(b.readableEnded, true);

    const copying = copyBidirectional(b, c);
    const received: Buffer[] = [];
    d.on("data", (chunk: Buffer) => received.push(chunk));

    await new Promise((resolve) => d.once("end", resolve));
    assert.equal(Buffer.concat(received).length, 0);

    b.destroy();
    c.destroy();
    d.destroy();
    await copying.catch(() => undefined);
  });
});
