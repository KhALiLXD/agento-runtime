import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "tests/v2");
const files = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => resolve(directory, entry.name))
  .sort();

if (files.length === 0) {
  console.error("No tests/v2/*.test.mjs files were found.");
  process.exit(1);
}

// Explicit arguments work across shells and Node versions, including paths with spaces.
const result = spawnSync(
  process.execPath,
  [...process.argv.slice(2), "--test", ...files],
  { cwd: root, stdio: "inherit", shell: false },
);

if (result.error) {
  console.error(result.error);
} else if (result.signal) {
  console.error(`Test process terminated by ${result.signal}.`);
}
process.exit(result.status ?? 1);
