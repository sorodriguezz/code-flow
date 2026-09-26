import type { ScaffoldPlatform } from "./api";

/**
 * Turns a template's steps into the one script its terminal runs — `/bin/sh` on macOS and Linux,
 * PowerShell on Windows (see `src-tauri/src/scaffold/run.rs` for why a file and a pty).
 *
 * A step is either a **program and its arguments** — quoted here, per shell, so a name with a space
 * or a quote in it can never become two arguments or a second command — or a **raw line per shell**,
 * for the few things that need the shell itself: sourcing nvm, a pipe from `curl`, a redirect into
 * `requirements.txt`. The raw lines are written by the catalogue and never contain user input except
 * through [`quote`].
 *
 * Every step prints a banner before it runs, so the terminal reads as a list of what happened, and
 * the script stops at the first step that fails — except the ones marked `optional`, whose failure
 * is reported and stepped over (an initial commit on a machine with no git identity is the case).
 */

export type Shell = "sh" | "ps";

export interface Step {
  /** Printed as the step's banner. */
  title: string;
  /** Absolute; the step runs from here. Omitted, it runs wherever the last step left off. */
  cwd?: string;
  /** A program and its arguments. */
  argv?: string[];
  /** Raw shell, per shell — used instead of `argv`. */
  sh?: string;
  ps?: string;
  /** A failure is reported and skipped rather than ending the script. */
  optional?: boolean;
  /**
   * Variables for this step's program — how a generator's own question is answered ahead of time
   * when it has no flag for it (Angular's analytics prompt, Nest's module-system one). Names are the
   * catalogue's; values are quoted like arguments.
   */
  env?: Record<string, string>;
}

export function shellFor(platform: ScaffoldPlatform): Shell {
  return platform === "windows" ? "ps" : "sh";
}

/** One argument, quoted for `shell`. Single quotes on both: nothing inside them is expanded. */
export function quote(shell: Shell, value: string): string {
  if (shell === "sh") {
    // `'` cannot appear inside single quotes at all, so it closes, is escaped, and reopens.
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
  }
  // PowerShell doubles a single quote inside a single-quoted string.
  return `'${value.replace(/'/g, "''")}'`;
}

function command(shell: Shell, argv: string[]): string {
  if (shell === "sh") return argv.map((arg) => quote("sh", arg)).join(" ");
  // `&` runs a quoted program name; `Cf-Check` turns a native failure into the script's own.
  return `& ${argv.map((arg) => quote("ps", arg)).join(" ")}; Cf-Check`;
}

function envPrefix(shell: Shell, env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {}).filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (entries.length === 0) return "";
  return shell === "sh"
    ? `${entries.map(([name, value]) => `${name}=${quote("sh", value)}`).join(" ")} `
    : `${entries.map(([name, value]) => `$env:${name} = ${quote("ps", value)}`).join("; ")}; `;
}

function body(shell: Shell, step: Step): string | null {
  if (step.argv) return envPrefix(shell, step.env) + command(shell, step.argv);
  const raw = shell === "sh" ? step.sh : step.ps;
  return raw ?? null;
}

const SH_PRELUDE = [
  "set -e",
  // Magenta banner, then green/amber for the endings — the terminal is the only log there is.
  `cf_step() { printf '\\n\\033[1;35m▸ %s\\033[0m\\n' "$1"; }`,
  `cf_skip() { printf '\\033[33m  (%s)\\033[0m\\n' "$1"; }`,
].join("\n");

const PS_PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "function Cf-Step($t) { Write-Host ''; Write-Host \"> $t\" -ForegroundColor Magenta }",
  "function Cf-Skip($t) { Write-Host \"  ($t)\" -ForegroundColor Yellow }",
  "function Cf-Check { if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }",
  // Inside an optional step a failure has to be *caught*, and `exit` cannot be.
  "function Cf-Throw { if ($LASTEXITCODE -ne 0) { throw \"exit $LASTEXITCODE\" } }",
].join("\n");

/**
 * The whole script. `skippedLabel` is what an optional step's failure prints ("skipped"), in the
 * app's language; `doneLabel` is the last line on success.
 */
export function buildScript(
  shell: Shell,
  steps: Step[],
  labels: { skipped: string; done: string },
): string {
  const lines: string[] = [shell === "sh" ? SH_PRELUDE : PS_PRELUDE];
  for (const step of steps) {
    const run = body(shell, step);
    if (run === null) continue;
    if (shell === "sh") {
      lines.push(`cf_step ${quote("sh", step.title)}`);
      const cd = step.cwd ? `cd ${quote("sh", step.cwd)} && ` : "";
      lines.push(
        step.optional
          ? `{ ${cd}${run}; } || cf_skip ${quote("sh", labels.skipped)}`
          : `${cd}${run}`,
      );
    } else {
      lines.push(`Cf-Step ${quote("ps", step.title)}`);
      const cd = step.cwd ? `Set-Location -LiteralPath ${quote("ps", step.cwd)}; ` : "";
      lines.push(
        step.optional
          ? `try { ${cd}${run.replace(/Cf-Check/g, "Cf-Throw")} } catch { Cf-Skip ${quote("ps", labels.skipped)} }`
          : `${cd}${run}`,
      );
    }
  }
  lines.push(
    shell === "sh"
      ? `printf '\\n\\033[1;32m✓ %s\\033[0m\\n' ${quote("sh", labels.done)}`
      : `Write-Host ''; Write-Host ${quote("ps", `✓ ${labels.done}`)} -ForegroundColor Green`,
  );
  return `${lines.join("\n")}\n`;
}

/** The command a step would run, as one line — what the install panel shows before it runs. */
export function previewStep(shell: Shell, step: Step): string {
  return body(shell, step)?.replace(/; Cf-Check/g, "") ?? "";
}
