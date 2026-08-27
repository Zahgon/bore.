//! Replays output recorded from the real `bore-cli 0.6.0` binary against the
//! migrated CLI. `interop.test.ts` proves the same thing against a live Rust
//! build, but it can only run where cargo output exists; this suite carries the
//! evidence with the repository so CLI parity is verified everywhere.
//!
//! Regenerate with `npm run golden:cli` after pointing `BORE_RUST_BIN` at a
//! reference build.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { PKG_ROOT, capture, jsCommand, normalize } from "./cli-support.ts";

interface GoldenCase {
  args: string[];
  stdout: string;
  stderr: string;
  code: number;
}

interface Golden {
  note: string;
  version: string;
  cases: GoldenCase[];
}

const GOLDEN_PATH = path.join(PKG_ROOT, "test", "golden", "cli.json");
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden;

test("the recorded reference output is intact", () => {
  assert.equal(golden.version, "bore-cli 0.6.0");
  assert.equal(golden.cases.length, 24);
  for (const recorded of golden.cases) {
    assert.ok(Array.isArray(recorded.args));
    assert.equal(typeof recorded.stdout, "string");
    assert.equal(typeof recorded.stderr, "string");
    assert.equal(typeof recorded.code, "number");
  }
});

test("the CLI reproduces the reference implementation byte for byte", async (t) => {
  for (const recorded of golden.cases) {
    await t.test(`bore ${recorded.args.join(" ")}`, async () => {
      const actual = await capture(process.execPath, jsCommand(recorded.args));
      assert.equal(normalize(actual.stdout), recorded.stdout);
      assert.equal(normalize(actual.stderr), recorded.stderr);
      assert.equal(actual.code, recorded.code);
    });
  }
});
