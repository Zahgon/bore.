//! Records the reference implementation's CLI output into
//! `test/golden/cli.json`. Point `BORE_RUST_BIN` at a `bore` build and run
//! `npm run golden:cli`.

import { writeFileSync } from "node:fs";
import path from "node:path";

import { CLEAN_ENV, PKG_ROOT, RUST_BIN, capture } from "../test/cli-support.ts";

const CASES: string[][] = [
  [],
  ["--help"],
  ["-h"],
  ["--version"],
  ["-V"],
  ["help"],
  ["help", "local"],
  ["help", "server"],
  ["local", "--help"],
  ["server", "--help"],
  ["bogus"],
  ["local"],
  ["local", "3000"],
  ["local", "3000", "-t", "x", "extra"],
  ["local", "70000", "-t", "x"],
  ["local", "abc", "-t", "x"],
  ["local", " 5", "-t", "x"],
  ["local", "99999999999999999999", "-t", "x"],
  ["local", "1", "-t"],
  ["local", "--", "-1", "-t", "x"],
  ["server", "--nope"],
  ["server", "--bind-addr", "zzz"],
  ["server", "--min-port", "5000", "--max-port", "3000"],
  ["server", "--min-port", "abc"],
];

const version = await capture(RUST_BIN, ["--version"]);
if (version.code !== 0) {
  throw new Error(`${RUST_BIN} is not a working bore binary (exit ${version.code})`);
}

const cases = [];
for (const args of CASES) {
  const { stdout, stderr, code } = await capture(RUST_BIN, args);
  cases.push({ args, stdout, stderr, code });
}

const golden = {
  note: `Recorded from ${RUST_BIN} with RUST_LOG=${CLEAN_ENV["RUST_LOG"]} and every BORE_* variable cleared.`,
  version: version.stdout.trim(),
  cases,
};

const target = path.join(PKG_ROOT, "test", "golden", "cli.json");
writeFileSync(target, `${JSON.stringify(golden, null, 2)}\n`);
process.stdout.write(`wrote ${cases.length} cases to ${target}\n`);
