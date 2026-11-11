/**
 * No re-pull route or service sends mail (epic #1046 phases 6 and 7, #1912 and #1913; ADR 0111,
 * decision 6 and the Phase 6 amendment), the automatic path's dispatch record, its callback and
 * its scheduler included. The dev database holds real addresses, so the record of a re-pull is
 * read by an administrator with `nemar admin repull status`, and nothing here may reach a person.
 *
 * A source scan on the syntax tree, as `repull-lineage-writer-scan.test.ts` does for the lineage
 * word: the transitive import closure of the service and of the routes may contain no mail module
 * (every file under `backend/src` whose name says email, mail or resend), and no file in it may
 * name a mail binding or call a sender. Each rule is proven to fire on a planted violation.
 * What this pins is the code the re-pull loads at run time; it cannot see a mail sent by a module
 * a future import pulls in unless that module is in the closure, which is exactly what it checks.
 */

import { describe, expect, test } from "bun:test";
import { SRC, type Tree, chainTo, createTree, importClosure, rel } from "./helpers/ts-scan";

const ROOTS = [
  `${SRC}/services/upstream-repull.ts`,
  `${SRC}/routes/admin/upstream-repulls.ts`,
  // The screen bound to the re-pull row and its callback (ADR 0111, decision 7): the publication
  // screen they share a workflow with mails its result, so their closure is pinned by name too.
  `${SRC}/services/upstream-repull-screen.ts`,
  `${SRC}/services/upstream-repull-verified.ts`,
  `${SRC}/routes/callbacks/identifier-screen-repull.ts`,
  // The automatic path's dispatch record and the callback its runs report to (epic #1046 phase 7).
  `${SRC}/services/upstream-repull-dispatch.ts`,
  `${SRC}/routes/callbacks/repull-state.ts`,
  // The scheduler that claims and sends those dispatches, and the staleness report it reads.
  `${SRC}/services/upstream-repull-scheduler.ts`,
  // The facts the machine-clean rule reads: they read the review's rows through `pr-review.ts`.
  `${SRC}/services/upstream-repull-facts.ts`,
  // The administrator's start of a review, which publishes a re-pull pull request's waiver (ADR
  // 0117), and the waiver's reader of the record.
  `${SRC}/services/pr-review-start.ts`,
  `${SRC}/services/pr-review-repull-waiver.ts`,
  // The advance tick that holds, gates and resumes the automatic re-pulls.
  `${SRC}/services/upstream-repull-advance.ts`,
  // The Worker's merge of an automatic re-pull, the one Worker path that merges a pull request.
  `${SRC}/services/upstream-repull-merge.ts`,
  // The week of the automatic path the weekly import report counts (epic #1046 phase 7h): it is
  // read into an issue on a public-facing repository and sends nothing.
  `${SRC}/services/upstream-repull-weekly.ts`,
];

/** Every module under `backend/src` that is a mail module, by name. */
function mailModules(tree: Tree): Set<string> {
  return new Set(tree.walk(SRC).filter((f) => /(^|\/)[^/]*(email|mail|resend)[^/]*\.ts$/i.test(f)));
}

const SENDERS = /\b(?:RESEND_API_KEY|SEND_EMAIL|sendEmail|sendMail|sendAdminEmail|notifyAdmins)\b/;

/** Chains from a root to a mail module, and the files in the closure that name a sender. */
function mailFindings(tree: Tree): string[] {
  const closure = importClosure(tree, ROOTS, new Set());
  const mail = mailModules(tree);
  const found: string[] = [];
  for (const file of closure.files) {
    if (mail.has(file)) found.push(`imports ${chainTo(closure, file)}`);
    else if (SENDERS.test(tree.read(file) ?? "")) found.push(`names a sender: ${rel(file)}`);
  }
  for (const u of closure.unanalyzable) found.push(`unanalyzable import in ${rel(u.file)}`);
  return found;
}

describe("the re-pull code sends no mail", () => {
  test("the closure of the service and the routes holds no mail module and names no sender", () => {
    const tree = createTree();
    const closure = importClosure(tree, ROOTS, new Set());
    // The scan is only as good as the closure it walks: it must reach the code it is about.
    for (const f of [
      "services/upstream-repull.ts",
      "routes/admin/upstream-repulls.ts",
      "services/import-error.ts",
      "services/upstream-repull-screen.ts",
      "services/upstream-repull-verified.ts",
      "services/upstream-repull-github.ts",
      "routes/callbacks/identifier-screen-repull.ts",
      "services/identifier-screen-stored.ts",
      "services/github/dispatch.ts",
      "services/upstream-repull-dispatch.ts",
      "services/github/callback-tokens.ts",
      "services/repull-switches.ts",
      "routes/callbacks/repull-state.ts",
      "routes/callbacks/bounded-json.ts",
      "services/upstream-repull-scheduler.ts",
      "services/upstream-status.ts",
      "services/openneuro-snapshots.ts",
      "services/github-auth.ts",
      "services/upstream-repull-facts.ts",
      "services/pr-review.ts",
      "services/pr-review-start.ts",
      "services/upstream-repull-advance.ts",
      "services/upstream-repull-merge.ts",
      "services/upstream-repull-weekly.ts",
    ]) {
      expect(closure.files.has(`${SRC}/${f}`)).toBe(true);
    }
    expect(mailModules(tree).size).toBeGreaterThan(0);
    expect(mailFindings(tree)).toEqual([]);
  }, 60_000);

  test("it fires when the re-pull screen reaches the publication screen, which mails", () => {
    // The re-pull's screen reads the publication screen's helpers from the module that holds no
    // mail; importing them from `identifier-screen.ts` instead would bring `email.ts` along.
    const base = createTree();
    const screen = `${SRC}/services/upstream-repull-screen.ts`;
    const planted = createTree({
      "services/upstream-repull-screen.ts": `${base.read(screen)}\nexport { screenEmailSection } from "./identifier-screen.js";\n`,
    });
    const findings = mailFindings(planted);
    expect(findings.some((f) => f.includes("identifier-screen.ts") && f.includes("email.ts"))).toBe(
      true,
    );
  }, 60_000);

  test("it fires on a direct import of a mail module", () => {
    const base = createTree();
    const planted = createTree({
      "services/upstream-repull.ts": `${base.read(ROOTS[0] as string)}\nimport { sendEmail } from "./email";\n`,
    });
    expect(mailFindings(planted).some((f) => f.startsWith("imports"))).toBe(true);
  }, 60_000);

  test("it fires on a mail module reached through another file", () => {
    const base = createTree();
    const planted = createTree({
      "services/import-error.ts": `${base.read(`${SRC}/services/import-error.ts`)}\nexport * from "./inbound-mail";\n`,
    });
    const findings = mailFindings(planted);
    expect(
      findings.some((f) => f.includes("import-error.ts") && f.includes("inbound-mail.ts")),
    ).toBe(true);
  }, 60_000);

  test("it fires on a dynamic import and on a sender named without an import", () => {
    const base = createTree();
    const dynamic = createTree({
      "routes/admin/upstream-repulls.ts": `${base.read(ROOTS[1] as string)}\nexport const later = () => import("../../services/email");\n`,
    });
    expect(mailFindings(dynamic).some((f) => f.startsWith("imports"))).toBe(true);
    const named = createTree({
      "services/datasetId.ts": `${base.read(`${SRC}/services/datasetId.ts`)}\nexport const x = (env: { RESEND_API_KEY?: string }) => env.RESEND_API_KEY;\n`,
    });
    expect(mailFindings(named).some((f) => f.startsWith("names a sender"))).toBe(true);
  }, 60_000);

  test("it fires when the automatic path's callback reaches a mail module", () => {
    const base = createTree();
    const callback = `${SRC}/routes/callbacks/repull-state.ts`;
    const planted = createTree({
      "routes/callbacks/repull-state.ts": `${base.read(callback)}\nexport { sendEmail } from "../../services/email";\n`,
    });
    expect(mailFindings(planted).some((f) => f.includes("repull-state.ts"))).toBe(true);
  }, 60_000);
});
