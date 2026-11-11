/**
 * Writes the plan configurations for a conformance run against the DEPLOYED development system (epic
 * #2014 phase #2020, slice S7), where the rig does not run: the issuer is the development API and the
 * authorization page is the staging website's.
 *
 *   RIG_OUT_DIR=<dir> DEV_ISSUER=... DEV_AUTHORIZATION_BASE=... DEV_CLIENT_ID=... \
 *     bun run scripts/oidc-conformance/dev-config.ts
 *
 * It writes three files into RIG_OUT_DIR (outside the uploaded paths, as in rig mode): `config-plan.json`,
 * `basic-plan.json` and `basic-plan-arg.txt`, the Basic plan's command-line argument with the modules
 * selected. It reads no secret: the client's id is public, and the secret in the configuration is a fixed
 * fake (`DUMMY_CLIENT_SECRET`), because the modules that run never reach the token endpoint.
 *
 * It refuses anything but the development system's own two hosts (see `dev-target.ts`).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDevTarget } from "./dev-target";
import {
  buildConfigPlanConfig,
  buildDevBasicPlanConfig,
  devBasicPlanArgument,
} from "./plan-config";

const outDir = process.env.RIG_OUT_DIR;
if (!outDir) {
  console.error("::error::RIG_OUT_DIR is required");
  process.exit(1);
}

let target: ReturnType<typeof resolveDevTarget>;
try {
  target = resolveDevTarget({
    issuer: process.env.DEV_ISSUER,
    authorizationBase: process.env.DEV_AUTHORIZATION_BASE,
    clientId: process.env.DEV_CLIENT_ID,
  });
} catch (err) {
  console.error(`::error::${(err as Error).message}`);
  process.exit(1);
}

const addr = {
  issuer: target.issuer,
  authorizationBase: target.authorizationBase,
  alias: process.env.RIG_ALIAS ?? "nemar",
};

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "config-plan.json"),
  JSON.stringify(buildConfigPlanConfig(addr), null, 2),
);
writeFileSync(
  join(outDir, "basic-plan.json"),
  JSON.stringify(buildDevBasicPlanConfig(addr, target.clientId), null, 2),
);
writeFileSync(join(outDir, "basic-plan-arg.txt"), devBasicPlanArgument());
console.log(
  `dev plan configurations written for ${target.issuer} (page ${target.authorizationBase})`,
);
