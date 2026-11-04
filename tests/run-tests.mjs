import { readdirSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const TESTS_ROOT = dirname(MODULE_PATH);
const REPOSITORY_ROOT = resolve(TESTS_ROOT, "..");

export function discoverTestFiles(root = TESTS_ROOT) {
  const files = [];

  const visit = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(path);
    }
  };

  visit(resolve(root));
  return files;
}

export function runTests({ testsRoot = TESTS_ROOT } = {}) {
  let files;
  try {
    files = discoverTestFiles(testsRoot);
  } catch (error) {
    console.error(`Could not discover test files: ${error.message}`);
    return 1;
  }

  if (files.length === 0) {
    console.error(`No test files matching **/*.test.js were found in ${resolve(testsRoot)}`);
    return 1;
  }

  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: REPOSITORY_ROOT,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Could not start the Node test runner: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`Node test runner terminated by ${result.signal}`);
    const signalNumber = osConstants.signals[result.signal];
    return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = process.platform === "win32"
  ? invokedPath.toLowerCase() === MODULE_PATH.toLowerCase()
  : invokedPath === MODULE_PATH;

if (isMain) process.exitCode = runTests();
