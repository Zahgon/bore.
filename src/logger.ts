//! Minimal structured logger emulating `tracing` + `tracing_subscriber::fmt`.
//!
//! The Rust crate calls `tracing_subscriber::fmt::init()` with the *default*
//! feature set of `tracing-subscriber` 0.3, which does **not** enable the
//! `env-filter` feature. In that configuration `fmt::init()` installs a
//! `Targets` filter built as follows, which this module reproduces verbatim:
//!
//! * `RUST_LOG` unset      -> `Targets::new().with_default(INFO)`
//! * `RUST_LOG` set        -> `Targets::from_str(&var)`, which has **no**
//!                            implicit default, so unmatched targets are off
//! * `RUST_LOG` unparsable -> warn on stderr and disable everything
//!
//! Output goes to **stdout** (the default `MakeWriter` of `fmt::Subscriber`),
//! byte-for-byte in the `tracing` full format, including the ANSI styling that
//! the subscriber applies unconditionally unless `NO_COLOR` is set:
//!
//! ```text
//! 2024-05-01T12:00:00.123456Z  INFO control{addr=127.0.0.1:52394}: bore_cli::server: incoming connection
//! ```

import { AsyncLocalStorage } from "node:async_hooks";

/// Log levels, ordered from most to least verbose.
export type Level = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/// Levels are displayed right-aligned in a five character column, matching the
/// `tracing` full formatter.
const LEVEL_LABEL: Record<Level, string> = {
  trace: "TRACE",
  debug: "DEBUG",
  info: " INFO",
  warn: " WARN",
  error: "ERROR",
};

/// Structured key/value pairs attached to an event or a span.
export type Fields = Record<string, unknown>;

interface Span {
  readonly name: string;
  readonly fields: Fields;
}

/// `tracing_subscriber::fmt::Subscriber::DEFAULT_MAX_LEVEL`.
const DEFAULT_MAX_LEVEL: Level = "info";

interface Directive {
  /// `undefined` means "applies to every target".
  readonly target: string | undefined;
  readonly level: Level | "off";
}

export class FilterParseError extends Error {}

const LEVEL_FILTER_ERROR =
  'error parsing level filter: expected one of "off", "error", "warn", "info", "debug", "trace", or a number 0-5';

/// `LevelFilter`'s `FromStr`: case-insensitive names plus the numeric aliases
/// where `0` is `off` and `5` is `trace`.
const LEVEL_NAMES = ["off", "error", "warn", "info", "debug", "trace"] as const;

const LEVEL_ALIASES = new Map<string, Level | "off">(
  LEVEL_NAMES.flatMap((name, index) => [
    [name, name],
    [String(index), name],
  ]),
);

function toLevel(raw: string): Level | "off" | undefined {
  return LEVEL_ALIASES.get(raw.toLowerCase());
}

/// Parses a `RUST_LOG` string exactly like `Targets::from_str`.
///
/// Unlike `EnvFilter`, `Targets` has **no implicit default**: a target that
/// matches no directive is disabled outright. An empty string therefore
/// silences all output, and any malformed directive fails the whole filter.
export function parseFilter(spec: string): Directive[] {
  const directives: Directive[] = [];
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (part === "") continue;
    const pieces = part.split("=");
    if (pieces.length > 2) {
      throw new FilterParseError(
        "invalid filter directive: too many '=' in filter directive, expected 0 or 1",
      );
    }
    if (pieces.length === 1) {
      const bare = pieces[0] as string;
      const level = toLevel(bare);
      // A bare word is a level when it parses as one, otherwise a target name
      // that is enabled all the way down to TRACE.
      directives.push(
        level === undefined
          ? { target: bare, level: "trace" }
          : { target: undefined, level },
      );
      continue;
    }
    const target = (pieces[0] as string).trim();
    const level = toLevel((pieces[1] as string).trim());
    if (level === undefined) throw new FilterParseError(LEVEL_FILTER_ERROR);
    directives.push({ target: target === "" ? undefined : target, level });
  }
  return directives;
}

function resolveFilter(spec: string | undefined): Directive[] {
  if (spec === undefined) return [{ target: undefined, level: DEFAULT_MAX_LEVEL }];
  try {
    return parseFilter(spec);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Ignoring \`RUST_LOG=${JSON.stringify(spec)}\`: ${reason}\n`);
    return [];
  }
}

let directives: Directive[] = resolveFilter(process.env["RUST_LOG"]);

/// Re-reads the filter, falling back to `RUST_LOG`. Exposed for tests.
export function reloadFilter(spec?: string): void {
  directives = resolveFilter(spec ?? process.env["RUST_LOG"]);
}

function isEnabled(level: Level, target: string): boolean {
  // Most specific matching target wins; otherwise the global directive applies.
  let best: Directive | undefined;
  let bestLength = -1;
  for (const directive of directives) {
    if (directive.target === undefined) {
      if (bestLength < 0) {
        best = directive;
        bestLength = 0;
      }
      continue;
    }
    if (target === directive.target || target.startsWith(`${directive.target}::`)) {
      if (directive.target.length > bestLength) {
        best = directive;
        bestLength = directive.target.length;
      }
    }
  }
  if (best === undefined) return false;
  if (best.level === "off") return false;
  return LEVEL_ORDER[level] >= LEVEL_ORDER[best.level];
}

const spanStorage = new AsyncLocalStorage<readonly Span[]>();

/// Runs `fn` inside a named span, mirroring `.instrument(info_span!(...))`.
export function withSpan<T>(name: string, fields: Fields, fn: () => T): T {
  const parent = spanStorage.getStore() ?? [];
  return spanStorage.run([...parent, { name, fields }], fn);
}

/// `tracing` renders `?value` (Debug) and `%value` (Display) fields; for the
/// values used by `bore` (ports, addresses, UUIDs, error strings) both render
/// the same way, so a single formatter suffices.
function formatValue(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  if (typeof value === "object") return JSON.stringify(value) ?? String(value);
  return String(value);
}

const LEVEL_COLOR: Record<Level, string> = {
  trace: "\u001b[35m",
  debug: "\u001b[34m",
  info: "\u001b[32m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
};

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const ITALIC = "\u001b[3m";

/// `tracing-subscriber` enables ANSI unconditionally; it only backs off when
/// `NO_COLOR` is set to a non-empty value. Notably it does *not* test for a tty.
let ansi = (process.env["NO_COLOR"] ?? "") === "";

/// Exposed so tests can assert both the styled and the plain rendering.
export function setAnsi(enabled: boolean): void {
  ansi = enabled;
}

export type Writer = (line: string) => void;

const defaultWriter: Writer = (line) => void process.stdout.write(line);

let writer: Writer = defaultWriter;

/// Redirects log output, mirroring `fmt::Subscriber::with_writer`.
export function setWriter(next: Writer | null): void {
  writer = next ?? defaultWriter;
}

function style(code: string, text: string): string {
  return ansi ? `${code}${text}${RESET}` : text;
}

function formatFields(fields: Fields): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${style(ITALIC, key)}${style(DIM, "=")}${formatValue(value)}`);
  }
  return parts.join(" ");
}

function formatSpans(): string {
  const spans = spanStorage.getStore();
  if (spans === undefined || spans.length === 0) return "";
  const rendered = spans.map((span) => {
    const fields = formatFields(span.fields);
    const name = style(BOLD, span.name);
    return fields === "" ? name : `${name}${style(BOLD, "{")}${fields}${style(BOLD, "}")}`;
  });
  return `${rendered.join(style(DIM, ":"))}${style(DIM, ":")} `;
}

/// `chrono`'s RFC 3339 rendering keeps microsecond precision; JavaScript clocks
/// only expose milliseconds, so the last three digits are always zero.
function timestamp(): string {
  return new Date().toISOString().replace("Z", "000Z");
}

/// Emits an event at `level` for `target`.
export function event(level: Level, target: string, message: string, fields: Fields = {}): void {
  if (!isEnabled(level, target)) return;
  const rendered = formatFields(fields);
  const suffix = rendered === "" ? "" : ` ${rendered}`;
  const head = `${style(DIM, timestamp())} ${style(LEVEL_COLOR[level], LEVEL_LABEL[level])} `;
  const scope = `${formatSpans()}${style(DIM, target)}${style(DIM, ":")} `;
  writer(`${head}${scope}${message}${suffix}\n`);
}

/// Creates the level helpers bound to a single target, mirroring the way each
/// Rust module's `tracing` macros are implicitly scoped to its module path.
export function logger(target: string): {
  trace: (message: string, fields?: Fields) => void;
  debug: (message: string, fields?: Fields) => void;
  info: (message: string, fields?: Fields) => void;
  warn: (message: string, fields?: Fields) => void;
  error: (message: string, fields?: Fields) => void;
} {
  return {
    trace: (message, fields) => event("trace", target, message, fields),
    debug: (message, fields) => event("debug", target, message, fields),
    info: (message, fields) => event("info", target, message, fields),
    warn: (message, fields) => event("warn", target, message, fields),
    error: (message, fields) => event("error", target, message, fields),
  };
}
