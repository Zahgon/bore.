//! Shared plumbing for the two suites that drive the CLI as a child process:
//! `cli-golden.test.ts` (always runs, replays recorded reference output) and
//! `interop.test.ts` (only runs when a real `bore` binary is available).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
export const JS_BIN = path.join(PKG_ROOT, "dist", "main.js");
export const JS_SOURCE = path.join(PKG_ROOT, "src", "main.ts");

export const RUST_BIN =
  process.env["BORE_RUST_BIN"] ??
  path.resolve(PKG_ROOT, "../../../scraped repos/rust/bore/target/release/bore");

export const HAS_RUST = existsSync(RUST_BIN) && existsSync(JS_BIN);

export const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  // Child coverage would merge `dist/` into the report and mask `src/` gaps.
  NODE_V8_COVERAGE: undefined,
  RUST_LOG: "info",
  BORE_LOCAL_PORT: undefined,
  BORE_SERVER: undefined,
  BORE_SECRET: undefined,
  BORE_MIN_PORT: undefined,
  BORE_MAX_PORT: undefined,
};

/// Runs the migrated CLI from `dist/` when it has been built, else straight
/// from source. Type stripping announces itself on stderr, which would corrupt
/// a byte-exact comparison, so the warning is silenced on the source path.
export function jsCommand(args: string[]): string[] {
  return existsSync(JS_BIN)
    ? [JS_BIN, ...args]
    : ["--disable-warning=ExperimentalWarning", JS_SOURCE, ...args];
}

export interface Capture {
  stdout: string;
  stderr: string;
  code: number;
}

export function capture(command: string, args: string[]): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: CLEAN_ENV });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

/// The one intentional difference between the two implementations' help text.
export function normalize(output: string): string {
  return output.replace("TCP tunnel in JavaScript", "TCP tunnel in Rust");
}
