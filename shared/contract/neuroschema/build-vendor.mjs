#!/usr/bin/env bun
/**
 * Regenerate the vendored neuroschema bundle (epic #896, #898).
 *
 * The website/CLI/data-plane dataset shape conforms to the neuroschema JSON
 * Schema, which lives in a SEPARATE repo (nemarOrg/neuroschema, Python/JSON-
 * Schema). nemar-cli CI can't reach that repo, so we vendor a self-contained
 * bundle of one root schema + all its transitive $refs into ONE file that
 * ajv (2020-12) can compile, and validate real data-plane responses against it.
 * Two roots are vendored: `dataset` (metadata.json) and `record` (one per
 * signal file, records.json and the Zarr engine protocol's `opened.record`).
 *
 * Bundling strategy: every reachable schema is assigned a stable absolute $id
 * (`nsc:/<path-from-schema-root>`), all external file $refs are rewritten to the
 * referenced file's $id, and internal `#/...` refs are left untouched (2020-12
 * resolves them against each schema's own $id). ajv then addSchema()s them all
 * and validates against the root named by the first argument (`dataset` or
 * `record`).
 *
 * Usage (from the nemar-cli repo root, with the neuroschema repo checked out
 * as a sibling):
 *   bun shared/contract/neuroschema/build-vendor.mjs ../neuroschema [dataset|record]
 * The root defaults to `dataset`; the output is `<root>.bundle.json`. Regenerate
 * BOTH bundles from the same neuroschema commit and commit them together.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const nscRepo = process.argv[2];
const rootName = process.argv[3] ?? "dataset";
if (!nscRepo || !["dataset", "record"].includes(rootName)) {
  console.error("usage: bun build-vendor.mjs <path-to-neuroschema-repo> [dataset|record]");
  process.exit(1);
}

// Read the neuroschema version straight from its pyproject.toml (single
// source of truth over there) so this script's own provenance stamp can't
// drift from what NEUROSCHEMA_VERSION gets hand-set to in dataset.ts. A
// minimal regex, not a TOML parser, because we only need the one line.
const pyproject = readFileSync(join(nscRepo, "pyproject.toml"), "utf8");
const versionMatch = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
const nscVersion = versionMatch ? versionMatch[1] : null;
if (!nscVersion) {
  console.error(`could not find version = "..." in ${join(nscRepo, "pyproject.toml")}`);
  process.exit(1);
}
const nscCommit = execFileSync("git", ["-C", nscRepo, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const schemaRoot = resolve(nscRepo, "schema");
const ROOT_REL = `core/${rootName}.schema.json`;
const idFor = (relPath) => `nsc:/${relPath}`;

const bundle = new Map(); // relPath -> rewritten schema

function rewriteRefs(node, fileDir) {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n, fileDir));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string" && !v.startsWith("#")) {
        const [file, frag] = v.split("#");
        const targetRel = relative(schemaRoot, resolve(fileDir, file));
        out.$ref = idFor(targetRel) + (frag ? `#${frag}` : "");
      } else {
        out[k] = rewriteRefs(v, fileDir);
      }
    }
    return out;
  }
  return node;
}

function walk(relPath) {
  if (bundle.has(relPath)) return;
  const abs = join(schemaRoot, relPath);
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  const fileDir = dirname(abs);
  // Discover external refs first so we walk them too.
  const refs = [...JSON.stringify(raw).matchAll(/"\$ref":\s*"([^"#]+)(#[^"]*)?"/g)];
  const rewritten = rewriteRefs(raw, fileDir);
  rewritten.$id = idFor(relPath);
  bundle.set(relPath, rewritten);
  for (const [, file] of refs) {
    walk(relative(schemaRoot, resolve(fileDir, file)));
  }
}

walk(ROOT_REL);

const out = {
  _provenance: {
    source: "https://github.com/nemarOrg/neuroschema",
    generated_by: "shared/contract/neuroschema/build-vendor.mjs",
    note: "Do not hand-edit; regenerate from the neuroschema repo.",
    neuroschema_version: nscVersion,
    source_commit: nscCommit,
  },
  root: idFor(ROOT_REL),
  schemas: [...bundle.values()],
};
const dest = join(import.meta.dir, `${rootName}.bundle.json`);
writeFileSync(dest, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${dest}: ${out.schemas.length} schemas, root ${out.root}`);
