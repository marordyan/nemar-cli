/**
 * The workflow's check of the suite's exported results (see `suite-authz.ts`): reads every module log in a
 * directory of result zips (or loose `test-log-*.json` files), prints what the authorization-endpoint stops
 * were, and exits 1 if any broke a rule.
 *
 *   bun run scripts/oidc-conformance/check-suite-authz.ts <results-dir> [minimum-stops]
 *
 * Zips are read with `unzip` (present on the runner), one stream per log; nothing is extracted to disk.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type ModuleLog, checkSuiteResults } from "./suite-authz";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-suite-authz.ts <results-dir> [minimum-stops]");
  process.exit(2);
}
const minimum = process.argv[3] === undefined ? 1 : Number(process.argv[3]);
if (!Number.isInteger(minimum) || minimum < 0) {
  console.error("::error::the minimum must be a whole number");
  process.exit(2);
}

const LOG = /(^|\/)test-log-[^/]+\.json$/;

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

let files: string[];
try {
  files = readdirSync(dir).sort();
} catch (err) {
  fail(`cannot read the results directory ${dir}: ${(err as Error).message}`);
}

const logs: ModuleLog[] = [];
for (const file of files) {
  const path = join(dir, file);
  if (file.endsWith(".zip")) {
    const names = spawnSync("unzip", ["-Z1", path], { encoding: "utf8" });
    if (names.status !== 0) fail(`cannot list ${file}: ${names.stderr || names.error?.message}`);
    for (const name of names.stdout.split("\n").filter((n) => LOG.test(n))) {
      const body = spawnSync("unzip", ["-p", path, name], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      if (body.status !== 0) fail(`cannot read ${name} in ${file}`);
      logs.push(parse(body.stdout, `${file}:${name}`));
    }
  } else if (LOG.test(file)) {
    logs.push(parse(readFileSync(path, "utf8"), file));
  }
}

function parse(text: string, where: string): ModuleLog {
  try {
    return JSON.parse(text) as ModuleLog;
  } catch {
    return fail(`${where} is not JSON`);
  }
}

const report = checkSuiteResults(logs, minimum);
console.log(`module logs read: ${logs.length}`);
console.log(`modules stopped at the authorization endpoint: ${report.checked}`);
for (const [error, count] of Object.entries(report.byError).sort()) {
  console.log(`  ${error}: ${count}`);
}
for (const violation of report.violations) console.error(`::error::${violation}`);
process.exit(report.violations.length === 0 ? 0 : 1);
