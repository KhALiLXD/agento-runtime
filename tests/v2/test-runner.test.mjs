import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runFixture(source, flags = []) {
  const root = mkdtempSync(join(tmpdir(), "agento runner with spaces "));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "tests/v2"), { recursive: true });
    const script = join(root, "scripts/run-tests.mjs");
    copyFileSync(
      new URL("../../scripts/run-tests.mjs", import.meta.url),
      script,
    );
    if (source !== undefined) {
      writeFileSync(join(root, "tests/v2/a test.test.mjs"), source);
    }
    // Simulate a standalone npm invocation, outside this parent test process.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [script, ...flags], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 15000,
      shell: false,
      env,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("test runner expands files itself and supports spaces and a different working directory", () => {
  const result = runFixture(
    'import test from "node:test"; test("fixture executes", () => {});',
    ["--test-reporter=tap"],
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ok 1 - fixture executes/);
});

test("test runner propagates a failing test exit code", () => {
  const result = runFixture(
    'import test from "node:test"; test("fixture fails", () => { throw new Error("expected fixture failure"); });',
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /expected fixture failure/);
});

test("test runner refuses an empty test directory", () => {
  const result = runFixture(undefined);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No tests\/v2\/\*\.test\.mjs files were found/);
});
