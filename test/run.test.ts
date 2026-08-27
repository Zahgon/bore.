import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CliExit, rootValueError } from "../src/cli.ts";
import { Delimited } from "../src/delimited.ts";
import { isEntryPoint, main, processStdio } from "../src/main.ts";
import { CONTROL_PORT } from "../src/protocol.ts";
import { run } from "../src/run.ts";
import { Server } from "../src/server.ts";
import { duplexPair } from "./support.ts";

describe("rootValueError", () => {
  test("mirrors Args::command().error(ErrorKind::InvalidValue, ..)", () => {
    const exit = rootValueError("port range is empty");
    assert.ok(exit instanceof CliExit);
    assert.equal(exit.code, 2);
    assert.equal(exit.stream, "stderr");
    assert.equal(
      exit.output,
      "error: port range is empty\n\nUsage: bore-cli <COMMAND>\n\nFor more information, try '--help'.\n",
    );
  });
});

describe("run", () => {
  test("rejects an empty port range exactly like main.rs", async () => {
    await assert.rejects(
      () =>
        run({
          kind: "server",
          minPort: 5000,
          maxPort: 3000,
          secret: null,
          bindAddr: "0.0.0.0",
          bindTunnels: null,
        }),
      (error: unknown) => {
        assert.ok(error instanceof CliExit);
        assert.match(error.output, /^error: port range is empty\n/);
        return true;
      },
    );
  });

  test("surfaces a control-port bind failure from the local subcommand", async () => {
    await assert.rejects(
      () =>
        run({
          kind: "local",
          localPort: 1,
          localHost: "localhost",
          to: "nonexistent.domain.for.demonstration",
          port: 0,
          secret: null,
        }),
      /could not connect to nonexistent\.domain\.for\.demonstration:7835/,
    );
  });
});

describe("Server bind address configuration", () => {
  test("setBindAddr moves the control listener", async () => {
    const server = new Server(1024, 65535, null);
    server.setBindAddr("127.0.0.1");
    const listening = server.listen();

    const probe = net.createServer();
    const occupied = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(true));
      probe.once("listening", () => resolve(false));
      probe.listen(CONTROL_PORT, "127.0.0.1");
    });
    probe.close();
    assert.equal(occupied, true, "the control port should be bound on 127.0.0.1");

    await server.close();
    await listening.catch(() => undefined);
  });

  test("setBindTunnels is independent of the control address", async () => {
    const server = new Server(1024, 65535, null);
    server.setBindAddr("127.0.0.1");
    server.setBindTunnels("127.0.0.1");
    const listening = server.listen();
    await server.close();
    await listening.catch(() => undefined);
  });
});

describe("Delimited accessors", () => {
  test("io exposes the underlying transport", () => {
    const [a, b] = duplexPair();
    const framed = new Delimited(a);
    assert.equal(framed.io, a);
    framed.destroy();
    b.destroy();
  });

  test("readableEnded flips once the peer sends FIN", async () => {
    const [a, b] = duplexPair();
    const framed = new Delimited(a);
    assert.equal(framed.readableEnded, false);

    b.end();
    assert.equal(await framed.recv(() => null), null);
    assert.equal(framed.readableEnded, true);

    framed.destroy();
    b.destroy();
  });

  test("a transport error surfaces as a frame error", async () => {
    const [a, b] = duplexPair();
    const framed = new Delimited(a);
    const receiving = framed.recv(() => null);
    a.emit("error", new Error("connection reset by peer"));

    await assert.rejects(
      () => receiving,
      (error: Error) => {
        assert.equal(error.message, "frame error, invalid byte length");
        assert.ok(error.cause instanceof Error);
        assert.match((error.cause as Error).message, /connection reset by peer/);
        return true;
      },
    );

    b.destroy();
  });
});

describe("isEntryPoint", () => {
  test("recognises the module the process was launched with", () => {
    const self = fileURLToPath(import.meta.url);
    const previous = process.argv[1];
    try {
      process.argv[1] = self;
      assert.equal(isEntryPoint(import.meta.url), true);
      assert.equal(isEntryPoint(pathToFileURL(path.join(path.dirname(self), "support.ts")).href), false);
    } finally {
      if (previous === undefined) process.argv.splice(1, 1);
      else process.argv[1] = previous;
    }
  });

  test("reports false when the entry path cannot be resolved", () => {
    const previous = process.argv[1];
    try {
      process.argv[1] = path.join(path.dirname(fileURLToPath(import.meta.url)), "no-such-file.ts");
      assert.equal(isEntryPoint(import.meta.url), false);
    } finally {
      if (previous === undefined) process.argv.splice(1, 1);
      else process.argv[1] = previous;
    }
  });
});

describe("main", () => {
  async function captureMain(args: readonly string[]): Promise<{
    stdout: string;
    stderr: string;
    code: number;
  }> {
    const argv = process.argv;
    const exitCode = process.exitCode;
    let stdout = "";
    let stderr = "";
    process.argv = ["node", "bore", ...args];
    process.exitCode = 0;
    try {
      await main({
        out: (text) => {
          stdout += text;
        },
        err: (text) => {
          stderr += text;
        },
      });
      return { stdout, stderr, code: Number(process.exitCode ?? 0) };
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
    }
  }

  test("defaults to the real process streams", () => {
    assert.equal(typeof processStdio.out, "function");
    assert.equal(typeof processStdio.err, "function");
    processStdio.out("");
    processStdio.err("");
  });

  test("prints the version on stdout and exits 0", async () => {
    const result = await captureMain(["--version"]);
    assert.equal(result.stdout, "bore-cli 0.6.0\n");
    assert.equal(result.stderr, "");
    assert.equal(result.code, 0);
  });

  test("prints help on stderr and exits 2 when invoked bare", async () => {
    const result = await captureMain([]);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^A modern, simple TCP tunnel/);
    assert.match(result.stderr, /Usage: bore <COMMAND>/);
    assert.equal(result.code, 2);
  });

  test("reports a clap parse failure on stderr and exits 2", async () => {
    const result = await captureMain(["local", "abc", "-t", "example.invalid"]);
    assert.equal(
      result.stderr,
      "error: invalid value 'abc' for '<LOCAL_PORT>': invalid digit found in string\n\nFor more information, try '--help'.\n",
    );
    assert.equal(result.code, 2);
  });

  test("renders a runtime failure as anyhow does and exits 1", async () => {
    const result = await captureMain([
      "local",
      "5000",
      "-t",
      "nonexistent.domain.for.demonstration",
    ]);
    assert.match(
      result.stderr,
      /^Error: could not connect to nonexistent\.domain\.for\.demonstration:7835\n\nCaused by:\n {4}\S/,
    );
    assert.equal(result.code, 1);
  });
});
