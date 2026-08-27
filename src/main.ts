#!/usr/bin/env node
//! Command-line entry point, ported from `src/main.rs`.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CliExit, parseArgs, type Command } from "./cli.ts";
import { formatErrorChain } from "./net.ts";
import { run } from "./run.ts";

/// True when `moduleUrl` is the module Node was launched with. `process.argv[1]`
/// keeps the symlink path npm's `.bin` shim uses, while `import.meta.url` is
/// always fully resolved, so both sides must be realpath'd before comparing.
export function isEntryPoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

/// The two streams `main` reports through. Injectable so tests can drive the
/// entry point in-process; patching `process.stdout` globally would also
/// swallow the test reporter's own output.
export interface Stdio {
  out(text: string): unknown;
  err(text: string): unknown;
}

export const processStdio: Stdio = {
  out: process.stdout.write.bind(process.stdout),
  err: process.stderr.write.bind(process.stderr),
};

export async function main(io: Stdio = processStdio): Promise<void> {
  let command: Command;
  try {
    command = parseArgs(process.argv.slice(2));
  } catch (error) {
    exitFromCli(error, io);
    return;
  }

  try {
    await run(command);
  } catch (error) {
    if (error instanceof CliExit) {
      exitFromCli(error, io);
      return;
    }
    // `fn main() -> anyhow::Result<()>` prints `Error: {:?}` and exits 1.
    io.err(`Error: ${formatErrorChain(error)}\n`);
    process.exitCode = 1;
  }
}

function exitFromCli(error: unknown, io: Stdio): void {
  if (!(error instanceof CliExit)) throw error;
  if (error.stream === "stdout") io.out(error.output);
  else io.err(error.output);
  process.exitCode = error.code;
}

if (isEntryPoint(import.meta.url)) await main();
