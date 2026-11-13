/**
 * `nemar doctor` — environment check.
 *
 * Reports which external tools NEMAR needs (git, git-annex, gh, aws, deno) are
 * installed, their versions, and platform-specific install commands for the
 * missing ones, and whether the local Zarr engine starts and its cache directory is writable.
 * Diagnostic only: always exits 0.
 */
import chalk from "chalk";
import { Command } from "commander";
import { getEnvironmentReport } from "../lib/debug-log.js";
import { checkAllTools } from "../lib/prerequisites.js";
import { plain } from "../lib/terminal-text.js";
import { checkZarrEngine } from "../lib/zarr-engine/doctor.js";

export interface DoctorOptions {
  report?: boolean;
}

/** The closing lines: what the tool and Zarr engine checks add up to. "All ... installed" is
 *  only said when the engine check passed too, so a failed engine is never summarised as all well. */
export function doctorSummary(
  tools: { available: boolean; required: boolean }[],
  engineChecks: { ok: boolean }[],
): string[] {
  const ready = tools.filter((t) => t.available).length;
  const missingRequired = tools.filter((t) => !t.available && t.required);
  const engineFailed = engineChecks.some((c) => !c.ok);
  const lines: string[] = [];
  if (missingRequired.length === 0) {
    lines.push(
      engineFailed
        ? chalk.yellow(
            `All ${tools.length} required tools are installed, but the Zarr engine needs attention (see above).`,
          )
        : chalk.green(`All ${tools.length} required tools are installed.`),
    );
  } else {
    lines.push(
      `${ready}/${tools.length} tools installed. Install the ${missingRequired.length} missing one(s) above, then re-run ${chalk.cyan("nemar doctor")}.`,
      chalk.dim(
        "Bun is the CLI runtime; the tools above are needed for upload, validation, and download.",
      ),
    );
    if (engineFailed) lines.push(chalk.yellow("The Zarr engine also needs attention (see above)."));
  }
  lines.push("");
  return lines;
}

export async function doctorAction(options: DoctorOptions = {}): Promise<void> {
  if (options.report) {
    // The environment section of the --debug diagnostic bundle (#1256),
    // without the HTTP trace -- plain text so it pastes cleanly into an
    // issue's Debug log field.
    console.log(await getEnvironmentReport());
    return;
  }

  const tools = await checkAllTools();

  console.log(chalk.bold("\nNEMAR environment check\n"));
  const runtime = process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`;
  console.log(chalk.dim(`  Runtime: ${runtime} on ${process.platform}/${process.arch}\n`));

  for (const t of tools) {
    const mark = t.available ? chalk.green("✓") : chalk.red("✗");
    const status = t.available
      ? (t.version ?? "ok")
      : chalk.red(t.timedOut ? "timed out" : "missing");
    console.log(
      `  ${mark} ${t.name.padEnd(16)} ${String(status).padEnd(12)} ${chalk.dim(t.purpose)}`,
    );
    if (!t.available) {
      console.log(`      ${chalk.yellow("Install")}: ${t.installInstruction}`);
    }
  }

  // The local Zarr engine (`nemar zarr read`). Diagnostic like the rest: it never changes the
  // exit code.
  console.log(chalk.bold("\n  Zarr engine\n"));
  const engineChecks = await checkZarrEngine();
  for (const c of engineChecks) {
    const mark = c.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(
      `  ${mark} ${c.name.padEnd(16)} ${c.ok ? chalk.dim(plain(c.detail)) : chalk.red(plain(c.detail))}`,
    );
  }

  console.log("");
  for (const line of doctorSummary(tools, engineChecks)) console.log(line);
}

export const doctorCommand = new Command("doctor")
  .description("Check that required tools (git, git-annex, gh, aws, deno) and the Zarr engine work")
  .option("--report", "Print a shareable environment report (no HTTP data) for bug reports")
  .action(doctorAction);
