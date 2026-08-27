import assert from "node:assert/strict";
import test from "node:test";

import { CliExit, parseArgs } from "../src/cli.ts";

const CLEARED = [
  "BORE_LOCAL_PORT",
  "BORE_SERVER",
  "BORE_SECRET",
  "BORE_MIN_PORT",
  "BORE_MAX_PORT",
] as const;

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of [...CLEARED, ...Object.keys(env)]) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function parse(argv: string[], env: Record<string, string | undefined> = {}) {
  return withEnv(env, () => parseArgs(argv));
}

function expectExit(argv: string[], env: Record<string, string | undefined> = {}): CliExit {
  try {
    parse(argv, env);
  } catch (error) {
    assert.ok(error instanceof CliExit, `expected CliExit, got ${String(error)}`);
    return error;
  }
  return assert.fail(`expected ${JSON.stringify(argv)} to exit`);
}

test("local: parses the full option set", () => {
  const command = parse([
    "local",
    "3000",
    "--local-host",
    "127.0.0.1",
    "--to",
    "bore.pub",
    "--port",
    "4242",
    "--secret",
    "hunter2",
  ]);
  assert.deepEqual(command, {
    kind: "local",
    localPort: 3000,
    localHost: "127.0.0.1",
    to: "bore.pub",
    port: 4242,
    secret: "hunter2",
  });
});

test("local: applies clap defaults", () => {
  assert.deepEqual(parse(["local", "8080", "-t", "bore.pub"]), {
    kind: "local",
    localPort: 8080,
    localHost: "localhost",
    to: "bore.pub",
    port: 0,
    secret: null,
  });
});

test("local: accepts short flags, `-n value`, `-nvalue` and `--name=value`", () => {
  assert.deepEqual(parse(["local", "1", "-lhost", "-t", "a", "-p9", "-sxyz"]), {
    kind: "local",
    localPort: 1,
    localHost: "host",
    to: "a",
    port: 9,
    secret: "xyz",
  });
  assert.deepEqual(parse(["local", "1", "--local-host=host", "--to=a", "--port=9"]), {
    kind: "local",
    localPort: 1,
    localHost: "host",
    to: "a",
    port: 9,
    secret: null,
  });
});

test("local: the positional port may appear before or after options", () => {
  const before = parse(["local", "5000", "-t", "a"]);
  const after = parse(["local", "-t", "a", "5000"]);
  assert.deepEqual(before, after);
});

test("local: environment variables provide fallbacks", () => {
  assert.deepEqual(
    parse(["local"], {
      BORE_LOCAL_PORT: "3000",
      BORE_SERVER: "bore.pub",
      BORE_SECRET: "s3cret",
    }),
    {
      kind: "local",
      localPort: 3000,
      localHost: "localhost",
      to: "bore.pub",
      port: 0,
      secret: "s3cret",
    },
  );
});

test("local: explicit arguments beat the environment", () => {
  const command = parse(["local", "1234", "-t", "explicit"], {
    BORE_LOCAL_PORT: "3000",
    BORE_SERVER: "from-env",
  });
  assert.deepEqual(command, {
    kind: "local",
    localPort: 1234,
    localHost: "localhost",
    to: "explicit",
    port: 0,
    secret: null,
  });
});

test("local: an empty BORE_SECRET still enables authentication", () => {
  const command = parse(["local", "1", "-t", "a"], { BORE_SECRET: "" });
  assert.equal(command.kind, "local");
  assert.equal(command.secret, "");
});

test("server: parses the full option set", () => {
  assert.deepEqual(
    parse([
      "server",
      "--min-port",
      "2000",
      "--max-port",
      "3000",
      "--secret",
      "abc",
      "--bind-addr",
      "127.0.0.1",
      "--bind-tunnels",
      "10.0.0.1",
    ]),
    {
      kind: "server",
      minPort: 2000,
      maxPort: 3000,
      secret: "abc",
      bindAddr: "127.0.0.1",
      bindTunnels: "10.0.0.1",
    },
  );
});

test("server: applies clap defaults", () => {
  assert.deepEqual(parse(["server"]), {
    kind: "server",
    minPort: 1024,
    maxPort: 65535,
    secret: null,
    bindAddr: "0.0.0.0",
    bindTunnels: null,
  });
});

test("server: reads BORE_MIN_PORT and BORE_MAX_PORT", () => {
  assert.deepEqual(parse(["server"], { BORE_MIN_PORT: "5000", BORE_MAX_PORT: "6000" }), {
    kind: "server",
    minPort: 5000,
    maxPort: 6000,
    secret: null,
    bindAddr: "0.0.0.0",
    bindTunnels: null,
  });
});

test("server: accepts IPv6 bind addresses", () => {
  const command = parse(["server", "--bind-addr", "::1"]);
  assert.equal(command.kind, "server");
  assert.equal(command.bindAddr, "::1");
});

test("--help prints the root help to stdout and exits 0", () => {
  const exit = expectExit(["--help"]);
  assert.equal(exit.code, 0);
  assert.equal(exit.stream, "stdout");
  assert.match(exit.output, /^A modern, simple TCP tunnel in JavaScript/);
  assert.match(exit.output, /\nUsage: bore <COMMAND>\n/);
  assert.match(exit.output, /\n {2}local {3}Starts a local proxy to the remote server\n/);
  assert.match(exit.output, /\n {2}server {2}Runs the remote proxy server\n/);
  assert.match(exit.output, /\n {2}help {4}Print this message or the help of the given subcommand\(s\)\n/);
  assert.match(exit.output, /\n {2}-h, --help {5}Print help\n/);
  assert.match(exit.output, /\n {2}-V, --version {2}Print version\n$/);
});

test("no arguments prints the root help to stderr and exits 2", () => {
  const exit = expectExit([]);
  assert.equal(exit.code, 2);
  assert.equal(exit.stream, "stderr");
  assert.equal(exit.output, expectExit(["--help"]).output);
});

test("--version prints the crate name and version", () => {
  const exit = expectExit(["--version"]);
  assert.equal(exit.code, 0);
  assert.equal(exit.stream, "stdout");
  assert.equal(exit.output, "bore-cli 0.6.0\n");
  assert.equal(expectExit(["-V"]).output, "bore-cli 0.6.0\n");
});

test("local --help matches the documented help text", () => {
  const exit = expectExit(["local", "--help"]);
  assert.equal(exit.code, 0);
  assert.equal(exit.stream, "stdout");
  assert.equal(
    exit.output,
    [
      "Starts a local proxy to the remote server",
      "",
      "Usage: bore local [OPTIONS] --to <TO> <LOCAL_PORT>",
      "",
      "Arguments:",
      "  <LOCAL_PORT>  The local port to expose [env: BORE_LOCAL_PORT=]",
      "",
      "Options:",
      "  -l, --local-host <HOST>  The local host to expose [default: localhost]",
      "  -t, --to <TO>            Address of the remote server to expose local ports to [env: BORE_SERVER=]",
      "  -p, --port <PORT>        Optional port on the remote server to select [default: 0]",
      "  -s, --secret <SECRET>    Optional secret for authentication [env: BORE_SECRET]",
      "  -h, --help               Print help",
      "",
    ].join("\n"),
  );
});

test("server --help matches the documented help text", () => {
  const exit = expectExit(["server", "--help"]);
  assert.equal(exit.code, 0);
  assert.equal(
    exit.output,
    [
      "Runs the remote proxy server",
      "",
      "Usage: bore server [OPTIONS]",
      "",
      "Options:",
      "      --min-port <MIN_PORT>          Minimum accepted TCP port number [env: BORE_MIN_PORT=] [default: 1024]",
      "      --max-port <MAX_PORT>          Maximum accepted TCP port number [env: BORE_MAX_PORT=] [default: 65535]",
      "  -s, --secret <SECRET>              Optional secret for authentication [env: BORE_SECRET]",
      "      --bind-addr <BIND_ADDR>        IP address to bind to, clients must reach this [default: 0.0.0.0]",
      "      --bind-tunnels <BIND_TUNNELS>  IP address where tunnels will listen on, defaults to --bind-addr",
      "  -h, --help                         Print help",
      "",
    ].join("\n"),
  );
});

test("help renders the current environment values, but hides the secret", () => {
  const local = expectExit(["local", "--help"], {
    BORE_LOCAL_PORT: "3000",
    BORE_SERVER: "bore.pub",
    BORE_SECRET: "do-not-print-me",
  });
  assert.match(local.output, /\[env: BORE_LOCAL_PORT=3000\]/);
  assert.match(local.output, /\[env: BORE_SERVER=bore\.pub\]/);
  assert.match(local.output, /\[env: BORE_SECRET\]/);
  assert.doesNotMatch(local.output, /do-not-print-me/);
});

test("`help <subcommand>` prints that subcommand's help", () => {
  assert.equal(expectExit(["help", "local"]).output, expectExit(["local", "--help"]).output);
  assert.equal(expectExit(["help", "server"]).output, expectExit(["server", "--help"]).output);
  assert.equal(expectExit(["help"]).output, expectExit(["--help"]).output);
});

test("unrecognized subcommands exit 2 with the root usage", () => {
  const exit = expectExit(["bogus"]);
  assert.equal(exit.code, 2);
  assert.equal(exit.stream, "stderr");
  assert.equal(
    exit.output,
    [
      "error: unrecognized subcommand 'bogus'",
      "",
      "Usage: bore <COMMAND>",
      "",
      "For more information, try '--help'.",
      "",
    ].join("\n"),
  );
});

test("missing required arguments are reported together", () => {
  const exit = expectExit(["local"]);
  assert.equal(exit.code, 2);
  assert.equal(
    exit.output,
    [
      "error: the following required arguments were not provided:",
      "  --to <TO>",
      "  <LOCAL_PORT>",
      "",
      "Usage: bore local --to <TO> <LOCAL_PORT>",
      "",
      "For more information, try '--help'.",
      "",
    ].join("\n"),
  );
});

test("a missing --to is reported on its own", () => {
  const exit = expectExit(["local", "3000"]);
  assert.equal(
    exit.output,
    [
      "error: the following required arguments were not provided:",
      "  --to <TO>",
      "",
      "Usage: bore local --to <TO> <LOCAL_PORT>",
      "",
      "For more information, try '--help'.",
      "",
    ].join("\n"),
  );
});

test("out-of-range ports report clap's range message without a usage block", () => {
  const exit = expectExit(["local", "70000", "-t", "x"]);
  assert.equal(exit.code, 2);
  assert.equal(
    exit.output,
    [
      "error: invalid value '70000' for '<LOCAL_PORT>': 70000 is not in 0..=65535",
      "",
      "For more information, try '--help'.",
      "",
    ].join("\n"),
  );
});

test("integer parsing reproduces Rust's FromStr wording", () => {
  const message = (argv: string[]) => expectExit(argv).output.split("\n")[0];
  assert.equal(
    message(["local", "abc", "-t", "x"]),
    "error: invalid value 'abc' for '<LOCAL_PORT>': invalid digit found in string",
  );
  assert.equal(
    message(["local", " 5", "-t", "x"]),
    "error: invalid value ' 5' for '<LOCAL_PORT>': invalid digit found in string",
  );
  assert.equal(
    message(["local", "99999999999999999999", "-t", "x"]),
    "error: invalid value '99999999999999999999' for '<LOCAL_PORT>': number too large to fit in target type",
  );
  assert.equal(
    message(["server", "--min-port", "-99999999999999999999"]),
    "error: invalid value '-99999999999999999999' for '--min-port <MIN_PORT>': number too small to fit in target type",
  );
});

test("a leading plus is accepted, mirroring i64::from_str", () => {
  const command = parse(["local", "+5", "-t", "x"]);
  assert.equal(command.kind, "local");
  assert.equal(command.localPort, 5);
});

test("invalid IP addresses are rejected", () => {
  const exit = expectExit(["server", "--bind-addr", "zzz"]);
  assert.equal(
    exit.output.split("\n")[0],
    "error: invalid value 'zzz' for '--bind-addr <BIND_ADDR>': invalid IP address syntax",
  );
});

test("unexpected arguments report the subcommand usage", () => {
  assert.equal(
    expectExit(["local", "3000", "-t", "x", "extra"]).output,
    [
      "error: unexpected argument 'extra' found",
      "",
      "Usage: bore local [OPTIONS] --to <TO> <LOCAL_PORT>",
      "",
      "For more information, try '--help'.",
      "",
    ].join("\n"),
  );
  assert.equal(
    expectExit(["server", "--nope"]).output,
    [
      "error: unexpected argument '--nope' found",
      "",
      "Usage: bore server [OPTIONS]",
      "",
      "For more information, try '--help'.",
      "",
    ].join("\n"),
  );
});

test("a dangling option value is reported without a usage block", () => {
  assert.equal(
    expectExit(["local", "1", "-t"]).output,
    [
      "error: a value is required for '--to <TO>' but none was supplied",
      "",
      "For more information, try '--help'.",
      "",
    ].join("\n"),
  );
});

test("everything after `--` is treated as positional", () => {
  assert.equal(
    expectExit(["local", "--", "-1", "-t", "x"]).output.split("\n")[0],
    "error: unexpected argument '-t' found",
  );
});

// The three cases below were captured from the Rust original during behaviour
// verification. clap's diagnostics for an unrecognised token are not uniform:
// the wording depends on whether the token is a flag, the tip appears only when
// the command declares a positional that could otherwise swallow it, and the
// usage synopsis switches to the required-set form once every required argument
// has already been supplied. Each expectation here is literal Rust output.
test("root: an unknown flag is an unexpected argument, not an unknown subcommand", () => {
  const exit = expectExit(["--bogus"]);
  assert.equal(exit.code, 2);
  assert.equal(
    exit.output,
    "error: unexpected argument '--bogus' found\n" +
      "\nUsage: bore <COMMAND>\n" +
      "\nFor more information, try '--help'.\n",
  );
});

test("local: an unknown flag carries clap's tip line", () => {
  const exit = expectExit(["local", "--bogus"]);
  assert.equal(exit.code, 2);
  assert.equal(
    exit.output,
    "error: unexpected argument '--bogus' found\n" +
      "\n  tip: to pass '--bogus' as a value, use '-- --bogus'\n" +
      "\nUsage: bore local [OPTIONS] --to <TO> <LOCAL_PORT>\n" +
      "\nFor more information, try '--help'.\n",
  );
});

test("local: once the required arguments are satisfied clap prints the required-set usage", () => {
  const exit = expectExit(["local", "3000", "--to", "127.0.0.1", "--bogus"]);
  assert.equal(exit.code, 2);
  assert.equal(
    exit.output,
    "error: unexpected argument '--bogus' found\n" +
      "\n  tip: to pass '--bogus' as a value, use '-- --bogus'\n" +
      "\nUsage: bore local <LOCAL_PORT|--local-host <HOST>|--to <TO>|--port <PORT>|--secret <SECRET>>\n" +
      "\nFor more information, try '--help'.\n",
  );
});
