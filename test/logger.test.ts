import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  event,
  logger,
  parseFilter,
  reloadFilter,
  setAnsi,
  setWriter,
  withSpan,
} from "../src/logger.ts";

const ESC = "\u001b";

async function capture(body: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  setWriter((line) => chunks.push(line));
  try {
    await body();
  } finally {
    setWriter(null);
  }
  return chunks.join("");
}

/// Strips the leading timestamp so assertions can pin the rest byte-for-byte.
function withoutTimestamp(line: string, styled: boolean): string {
  const pattern = styled
    ? /^\u001b\[2m\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\u001b\[0m /
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z /;
  assert.match(line, pattern);
  return line.replace(pattern, "");
}

after(() => {
  setAnsi((process.env["NO_COLOR"] ?? "") === "");
  reloadFilter();
});

describe("logger", () => {
  it("renders a plain event exactly like tracing's full format", async () => {
    setAnsi(false);
    reloadFilter("info");
    const output = await capture(() => {
      event("info", "bore_cli::server", "server listening", { addr: "0.0.0.0" });
    });
    assert.equal(
      withoutTimestamp(output, false),
      " INFO bore_cli::server: server listening addr=0.0.0.0\n",
    );
  });

  it("renders spans and their fields before the target", async () => {
    setAnsi(false);
    reloadFilter("info");
    const output = await capture(() =>
      withSpan("control", { addr: "127.0.0.1:52394" }, () => {
        event("info", "bore_cli::server", "incoming connection");
      }),
    );
    assert.equal(
      withoutTimestamp(output, false),
      " INFO control{addr=127.0.0.1:52394}: bore_cli::server: incoming connection\n",
    );
  });

  it("emits the same ANSI sequences as tracing-subscriber", async () => {
    setAnsi(true);
    reloadFilter("info");
    const output = await capture(() =>
      withSpan("proxy", { id: "abc" }, () => {
        event("warn", "bore_cli::client", "unexpected hello", { err: 7 });
      }),
    );
    assert.equal(
      withoutTimestamp(output, true),
      `${ESC}[33m WARN${ESC}[0m ` +
        `${ESC}[1mproxy${ESC}[0m${ESC}[1m{${ESC}[0m` +
        `${ESC}[3mid${ESC}[0m${ESC}[2m=${ESC}[0mabc` +
        `${ESC}[1m}${ESC}[0m${ESC}[2m:${ESC}[0m ` +
        `${ESC}[2mbore_cli::client${ESC}[0m${ESC}[2m:${ESC}[0m ` +
        `unexpected hello ${ESC}[3merr${ESC}[0m${ESC}[2m=${ESC}[0m7\n`,
    );
  });

  it("right-aligns every level label in five columns", async () => {
    setAnsi(false);
    reloadFilter("trace");
    const output = await capture(() => {
      const log = logger("bore_cli::shared");
      log.trace("t");
      log.debug("d");
      log.info("i");
      log.warn("w");
      log.error("e");
    });
    const labels = output
      .split("\n")
      .filter(Boolean)
      .map((line) => withoutTimestamp(line, false).slice(0, 5));
    assert.deepEqual(labels, ["TRACE", "DEBUG", " INFO", " WARN", "ERROR"]);
  });

  it("defaults to INFO when RUST_LOG is absent", async () => {
    setAnsi(false);
    reloadFilter(undefined);
    const output = await capture(() => {
      const log = logger("bore_cli::server");
      log.debug("hidden");
      log.info("shown");
    });
    assert.equal(output.includes("hidden"), false);
    assert.equal(output.includes("shown"), true);
  });

  it("disables unmatched targets, because Targets has no implicit default", async () => {
    setAnsi(false);
    reloadFilter("bore_cli::server=debug,bore_cli::client=off");
    const output = await capture(() => {
      logger("bore_cli::server").debug("server debug");
      logger("bore_cli::client").error("client error");
      logger("bore_cli::shared").info("shared info");
    });
    assert.equal(output.includes("server debug"), true);
    assert.equal(output.includes("client error"), false);
    assert.equal(output.includes("shared info"), false);
  });

  it("silences everything when RUST_LOG is set but empty", async () => {
    setAnsi(false);
    reloadFilter("");
    const output = await capture(() => logger("bore_cli::server").error("boom"));
    assert.equal(output, "");
  });

  it("treats an unknown bare word as a target name, not a level", async () => {
    setAnsi(false);
    reloadFilter("bogusvalue");
    assert.equal(await capture(() => logger("bore_cli::server").error("boom")), "");

    reloadFilter("bore_cli");
    assert.match(await capture(() => logger("bore_cli::server").info("ok")), /ok/);
  });

  it("accepts numeric level filters", async () => {
    setAnsi(false);
    reloadFilter("3");
    const output = await capture(() => {
      logger("bore_cli::server").debug("hidden");
      logger("bore_cli::server").info("shown");
    });
    assert.equal(output.includes("hidden"), false);
    assert.equal(output.includes("shown"), true);
  });

  it("matches targets on :: boundaries and prefers the longest match", async () => {
    setAnsi(false);
    reloadFilter("bore_cli=error,bore_cli::server=trace");
    const output = await capture(() => {
      logger("bore_cli::server").trace("server trace");
      logger("bore_cli::client").info("client info");
      logger("bore_cli::client").error("client error");
      logger("bore_cli_other::x").error("unrelated");
    });
    assert.equal(output.includes("server trace"), true);
    assert.equal(output.includes("client info"), false);
    assert.equal(output.includes("client error"), true);
    assert.equal(output.includes("unrelated"), false);
  });

  it("rejects malformed filters and reports them like tracing-subscriber", () => {
    assert.throws(() => parseFilter("bore_cli=notalevel"), {
      name: "Error",
      message: /expected one of "off", "error", "warn", "info", "debug", "trace", or a number 0-5/,
    });
    assert.throws(() => parseFilter("bore_cli::server=info,junk=="), {
      message: /too many '=' in filter directive, expected 0 or 1/,
    });
  });

  it("disables all output when the filter fails to parse", async () => {
    setAnsi(false);
    const warnings: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    Object.defineProperty(process.stderr, "write", {
      configurable: true,
      writable: true,
      value: (chunk: string): boolean => (warnings.push(String(chunk)), true),
    });
    try {
      reloadFilter("bore_cli=notalevel");
    } finally {
      Object.defineProperty(process.stderr, "write", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /^Ignoring `RUST_LOG="bore_cli=notalevel"`: /);
    assert.equal(await capture(() => logger("bore_cli::server").error("boom")), "");
  });

  it("nests spans with a colon separator", async () => {
    setAnsi(false);
    reloadFilter("info");
    const output = await capture(() =>
      withSpan("control", { addr: "1.2.3.4:5" }, () =>
        withSpan("proxy", { id: "xyz" }, () => {
          event("info", "bore_cli::server", "nested");
        }),
      ),
    );
    assert.equal(
      withoutTimestamp(output, false),
      " INFO control{addr=1.2.3.4:5}:proxy{id=xyz}: bore_cli::server: nested\n",
    );
  });

  it("keeps span context across await points", async () => {
    setAnsi(false);
    reloadFilter("info");
    const output = await capture(async () => {
      await withSpan("control", { addr: "a" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        event("info", "bore_cli::server", "after await");
      });
    });
    assert.match(output, /control\{addr=a\}: bore_cli::server: after await/);
  });
});
