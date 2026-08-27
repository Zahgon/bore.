//! Command-line parsing, reproducing the `clap` 4 derive setup in `src/main.rs`.
//!
//! Help output, error wording and the exit code used for usage errors (2) all
//! follow `clap`, so scripts wrapping the Rust binary keep working.

import { isIP } from "node:net";

export const BIN_NAME = "bore";
export const VERSION = "0.6.0";

/// `clap` derives the version banner and some usage strings from the *crate*
/// name rather than the binary name. Keeping `bore-cli` verbatim means scripts
/// that grep `bore --version` keep working after the migration.
export const PKG_NAME = "bore-cli";

export const ABOUT =
  "A modern, simple TCP tunnel in JavaScript that exposes local ports to a remote server, bypassing standard NAT connection firewalls.";

const ROOT_USAGE = `${BIN_NAME} <COMMAND>`;

/// `Args::command()` in `main.rs` is built from the crate name, so the error it
/// raises for an empty port range reports `bore-cli <COMMAND>`, not `bore`.
const ROOT_COMMAND_USAGE = `${PKG_NAME} <COMMAND>`;
const LOCAL_USAGE = `${BIN_NAME} local [OPTIONS] --to <TO> <LOCAL_PORT>`;
const SERVER_USAGE = `${BIN_NAME} server [OPTIONS]`;

/// Parsed subcommand, mirroring the `Command` enum in `src/main.rs`.
export type Command =
  | {
      readonly kind: "local";
      readonly localPort: number;
      readonly localHost: string;
      readonly to: string;
      readonly port: number;
      readonly secret: string | null;
    }
  | {
      readonly kind: "server";
      readonly minPort: number;
      readonly maxPort: number;
      readonly secret: string | null;
      readonly bindAddr: string;
      readonly bindTunnels: string | null;
    };

/// A `clap`-style terminating condition: either printed help/version (exit 0)
/// or a usage error (exit 2).
export class CliExit extends Error {
  readonly output: string;
  readonly code: number;
  readonly stream: "stdout" | "stderr";

  constructor(output: string, code: number, stream: "stdout" | "stderr") {
    super(output);
    this.name = "CliExit";
    this.output = output;
    this.code = code;
    this.stream = stream;
  }
}

function usageError(message: string, usage: string, tipFor?: string): CliExit {
  const tip =
    tipFor === undefined ? "" : `\n  tip: to pass '${tipFor}' as a value, use '-- ${tipFor}'\n`;
  return new CliExit(
    `error: ${message}\n${tip}\nUsage: ${usage}\n\nFor more information, try '--help'.\n`,
    2,
    "stderr",
  );
}

/// How clap renders an `unexpected argument` error for one subcommand.
///
/// The two knobs are not cosmetic. clap only offers the `-- <arg>` tip when the
/// command declares a positional that could otherwise have swallowed the token,
/// and it swaps the ordinary synopsis for the required-set spelling once every
/// required argument has already been supplied. Both were measured against the
/// original binary; see test/cli.test.ts.
interface UnexpectedArgRules {
  readonly hasPositional: boolean;
  readonly requiredSetUsage?: string;
  readonly requiredSatisfied?: (reader: Reader) => boolean;
}

function valueError(message: string): CliExit {
  return new CliExit(`error: ${message}\n\nFor more information, try '--help'.\n`, 2, "stderr");
}

/// Raised by `main.rs`'s `Args::command().error(ErrorKind::InvalidValue, ..)`.
export function rootValueError(message: string): CliExit {
  return usageError(message, ROOT_COMMAND_USAGE);
}

function envSuffix(name: string, hideValue: boolean): string {
  if (hideValue) return `[env: ${name}]`;
  return `[env: ${name}=${process.env[name] ?? ""}]`;
}

export function rootHelp(): string {
  return `${ABOUT}

Usage: ${ROOT_USAGE}

Commands:
  local   Starts a local proxy to the remote server
  server  Runs the remote proxy server
  help    Print this message or the help of the given subcommand(s)

Options:
  -h, --help     Print help
  -V, --version  Print version
`;
}

export function localHelp(): string {
  return `Starts a local proxy to the remote server

Usage: ${LOCAL_USAGE}

Arguments:
  <LOCAL_PORT>  The local port to expose ${envSuffix("BORE_LOCAL_PORT", false)}

Options:
  -l, --local-host <HOST>  The local host to expose [default: localhost]
  -t, --to <TO>            Address of the remote server to expose local ports to ${envSuffix("BORE_SERVER", false)}
  -p, --port <PORT>        Optional port on the remote server to select [default: 0]
  -s, --secret <SECRET>    Optional secret for authentication ${envSuffix("BORE_SECRET", true)}
  -h, --help               Print help
`;
}

export function serverHelp(): string {
  return `Runs the remote proxy server

Usage: ${SERVER_USAGE}

Options:
      --min-port <MIN_PORT>          Minimum accepted TCP port number ${envSuffix("BORE_MIN_PORT", false)} [default: 1024]
      --max-port <MAX_PORT>          Maximum accepted TCP port number ${envSuffix("BORE_MAX_PORT", false)} [default: 65535]
  -s, --secret <SECRET>              Optional secret for authentication ${envSuffix("BORE_SECRET", true)}
      --bind-addr <BIND_ADDR>        IP address to bind to, clients must reach this [default: 0.0.0.0]
      --bind-tunnels <BIND_TUNNELS>  IP address where tunnels will listen on, defaults to --bind-addr
  -h, --help                         Print help
`;
}

/// `clap`'s `value_parser!(u16)` is a `RangedI64ValueParser`: it parses the
/// argument as an `i64` (so `FromStr`'s wording applies) and then range-checks
/// it against `0..=65535`. All three failure modes are reproduced verbatim.
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function parseU16(raw: string, forArg: string): number {
  const fail = (reason: string): never => {
    throw valueError(`invalid value '${raw}' for '${forArg}': ${reason}`);
  };
  if (!/^[+-]?\d+$/.test(raw)) fail("invalid digit found in string");
  const value = BigInt(raw);
  if (value > I64_MAX) fail("number too large to fit in target type");
  if (value < I64_MIN) fail("number too small to fit in target type");
  if (value < 0n || value > 65535n) fail(`${value} is not in 0..=65535`);
  return Number(value);
}

function parseIpAddr(raw: string, forArg: string): string {
  if (isIP(raw) === 0) {
    throw valueError(`invalid value '${raw}' for '${forArg}': invalid IP address syntax`);
  }
  return raw;
}

interface OptionSpec {
  readonly long: string;
  readonly short?: string;
  readonly display: string;
}

/// Reads `--name value`, `--name=value`, `-n value` and `-nvalue`.
class Reader {
  #index = 0;
  readonly #argv: readonly string[];
  readonly positionals: string[] = [];
  readonly values = new Map<string, string>();

  constructor(argv: readonly string[]) {
    this.#argv = argv;
  }

  parse(
    options: readonly OptionSpec[],
    usage: string,
    helpText: () => string,
    unexpected?: UnexpectedArgRules,
  ): void {
    while (this.#index < this.#argv.length) {
      const arg = this.#argv[this.#index] as string;
      this.#index += 1;
      if (arg === "--help" || arg === "-h") throw new CliExit(helpText(), 0, "stdout");
      if (arg === "--") {
        this.positionals.push(...this.#argv.slice(this.#index));
        return;
      }
      if (!arg.startsWith("-") || arg === "-") {
        this.positionals.push(arg);
        continue;
      }
      const spec = this.#match(arg, options);
      if (spec === undefined) {
        throw this.#unexpectedArg(arg, usage, unexpected);
      }
      const [option, inline] = spec;
      if (inline !== undefined) {
        this.values.set(option.long, inline);
        continue;
      }
      const next = this.#argv[this.#index];
      if (next === undefined) {
        // clap omits the usage block for this particular error.
        throw valueError(`a value is required for '${option.display}' but none was supplied`);
      }
      this.#index += 1;
      this.values.set(option.long, next);
    }
  }

  #unexpectedArg(arg: string, usage: string, rules?: UnexpectedArgRules): CliExit {
    const tipFor = rules?.hasPositional === true && arg.startsWith("--") ? arg : undefined;
    const satisfied = rules?.requiredSatisfied?.(this) === true;
    const shown =
      satisfied && rules?.requiredSetUsage !== undefined ? rules.requiredSetUsage : usage;
    return usageError(`unexpected argument '${arg}' found`, shown, tipFor);
  }

  #match(
    arg: string,
    options: readonly OptionSpec[],
  ): readonly [OptionSpec, string | undefined] | undefined {
    for (const option of options) {
      const long = `--${option.long}`;
      if (arg === long) return [option, undefined];
      if (arg.startsWith(`${long}=`)) return [option, arg.slice(long.length + 1)];
      if (option.short !== undefined) {
        const short = `-${option.short}`;
        if (arg === short) return [option, undefined];
        if (arg.startsWith(short) && arg.length > short.length && !arg.startsWith("--")) {
          return [option, arg.slice(short.length)];
        }
      }
    }
    return undefined;
  }
}

const LOCAL_OPTIONS: readonly OptionSpec[] = [
  { long: "local-host", short: "l", display: "--local-host <HOST>" },
  { long: "to", short: "t", display: "--to <TO>" },
  { long: "port", short: "p", display: "--port <PORT>" },
  { long: "secret", short: "s", display: "--secret <SECRET>" },
];

const LOCAL_REQUIRED_SET_USAGE = `${BIN_NAME} local <LOCAL_PORT|${LOCAL_OPTIONS.map(
  (o) => o.display,
).join("|")}>`;

const SERVER_OPTIONS: readonly OptionSpec[] = [
  { long: "min-port", display: "--min-port <MIN_PORT>" },
  { long: "max-port", display: "--max-port <MAX_PORT>" },
  { long: "secret", short: "s", display: "--secret <SECRET>" },
  { long: "bind-addr", display: "--bind-addr <BIND_ADDR>" },
  { long: "bind-tunnels", display: "--bind-tunnels <BIND_TUNNELS>" },
];

function envOr(name: string): string | undefined {
  return process.env[name];
}

function parseLocal(argv: readonly string[]): Command {
  const reader = new Reader(argv);
  reader.parse(LOCAL_OPTIONS, LOCAL_USAGE, localHelp, {
    hasPositional: true,
    requiredSetUsage: LOCAL_REQUIRED_SET_USAGE,
    requiredSatisfied: (r) =>
      (r.positionals[0] ?? envOr("BORE_LOCAL_PORT")) !== undefined &&
      (r.values.get("to") ?? envOr("BORE_SERVER")) !== undefined,
  });

  // clap rejects surplus positionals before it checks for missing ones.
  if (reader.positionals.length > 1) {
    throw usageError(`unexpected argument '${reader.positionals[1]}' found`, LOCAL_USAGE);
  }

  const rawPort = reader.positionals[0] ?? envOr("BORE_LOCAL_PORT");
  const to = reader.values.get("to") ?? envOr("BORE_SERVER");
  const missing: string[] = [];
  if (to === undefined) missing.push("  --to <TO>");
  if (rawPort === undefined) missing.push("  <LOCAL_PORT>");
  if (missing.length > 0) {
    throw usageError(
      `the following required arguments were not provided:\n${missing.join("\n")}`,
      `${BIN_NAME} local --to <TO> <LOCAL_PORT>`,
    );
  }

  const secret = reader.values.get("secret") ?? envOr("BORE_SECRET");
  return {
    kind: "local",
    localPort: parseU16(rawPort as string, "<LOCAL_PORT>"),
    localHost: reader.values.get("local-host") ?? "localhost",
    to: to as string,
    port: parseU16(reader.values.get("port") ?? "0", "--port <PORT>"),
    secret: secret ?? null,
  };
}

function parseServer(argv: readonly string[]): Command {
  const reader = new Reader(argv);
  reader.parse(SERVER_OPTIONS, SERVER_USAGE, serverHelp, { hasPositional: false });
  if (reader.positionals.length > 0) {
    throw usageError(`unexpected argument '${reader.positionals[0]}' found`, SERVER_USAGE);
  }

  const secret = reader.values.get("secret") ?? envOr("BORE_SECRET");
  const bindTunnels = reader.values.get("bind-tunnels");
  return {
    kind: "server",
    minPort: parseU16(
      reader.values.get("min-port") ?? envOr("BORE_MIN_PORT") ?? "1024",
      "--min-port <MIN_PORT>",
    ),
    maxPort: parseU16(
      reader.values.get("max-port") ?? envOr("BORE_MAX_PORT") ?? "65535",
      "--max-port <MAX_PORT>",
    ),
    secret: secret ?? null,
    bindAddr: parseIpAddr(reader.values.get("bind-addr") ?? "0.0.0.0", "--bind-addr <BIND_ADDR>"),
    bindTunnels:
      bindTunnels === undefined
        ? null
        : parseIpAddr(bindTunnels, "--bind-tunnels <BIND_TUNNELS>"),
  };
}

/// Parses process arguments (without `node` and the script path).
export function parseArgs(argv: readonly string[]): Command {
  const first = argv[0];
  if (first === undefined) {
    throw new CliExit(rootHelp(), 2, "stderr");
  }
  switch (first) {
    case "-h":
    case "--help":
      throw new CliExit(rootHelp(), 0, "stdout");
    case "-V":
    case "--version":
      throw new CliExit(`${PKG_NAME} ${VERSION}\n`, 0, "stdout");
    case "--":
      throw usageError(`unrecognized subcommand '${first}'`, ROOT_USAGE);
    case "help": {
      const topic = argv[1];
      if (topic === "local") throw new CliExit(localHelp(), 0, "stdout");
      if (topic === "server") throw new CliExit(serverHelp(), 0, "stdout");
      throw new CliExit(rootHelp(), 0, "stdout");
    }
    case "local":
      return parseLocal(argv.slice(1));
    case "server":
      return parseServer(argv.slice(1));
    default:
      if (first.startsWith("-")) {
        throw usageError(`unexpected argument '${first}' found`, ROOT_USAGE);
      }
      throw usageError(`unrecognized subcommand '${first}'`, ROOT_USAGE);
  }
}
