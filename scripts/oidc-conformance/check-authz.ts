/**
 * The workflow's check of the rig's authorization log (see `authz-log.ts`): prints what the run's
 * authorization responses were, and exits 1 if any broke a rule.
 *
 *   bun run scripts/oidc-conformance/check-authz.ts <rig.log>
 */

import { readFileSync } from "node:fs";
import { checkAuthorizationLog } from "./authz-log";

const path = process.argv[2];
if (!path) {
  console.error("usage: check-authz.ts <rig.log>");
  process.exit(2);
}

let log: string;
try {
  log = readFileSync(path, "utf8");
} catch (err) {
  console.error(`::error::cannot read the rig's log at ${path}: ${(err as Error).message}`);
  process.exit(1);
}

const report = checkAuthorizationLog(log);
console.log(`authorization requests: ${report.requests}`);
console.log(`authorization lines: ${report.authorizationLines}`);
console.log(`authorization responses: ${report.responses}`);
for (const [error, count] of Object.entries(report.byError).sort()) {
  console.log(`  ${error}: ${count}`);
}
for (const violation of report.violations) console.error(`::error::${violation}`);
process.exit(report.violations.length === 0 ? 0 : 1);
