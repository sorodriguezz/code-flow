/**
 * How the «Worktrees» layout starts an agent's own CLI in a terminal: which agents have one, and
 * the line typed into the shell.
 *
 * Pure, because the line is typed into a real shell in the user's working copy: the quoting and
 * the one flag it adds are worth pinning, not discovering.
 */

import { quotePath } from "../../components/terminal/fileLinks";

/**
 * The agents a terminal can run interactively: the CLIs this app already drives headless, by the
 * binary each one installs. HTTP and in-process providers have no interactive CLI to start.
 */
export const CLI_PROVIDERS = ["claude", "codex", "gemini", "grok", "opencode", "cline"] as const;

export function hasCli(provider: string): boolean {
  return (CLI_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * The family of the shell the line is typed into, which decides its quoting: a POSIX shell (macOS,
 * Linux, and Git Bash — Windows' default terminal), PowerShell, or `cmd`.
 */
export type CliShell = "posix" | "powershell" | "cmd";

/** A shell profile's family, by its program: `pwsh.exe`/`powershell.exe`, `cmd.exe`, or POSIX. */
export function shellFamily(command: string): CliShell {
  const program = command.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  if (program === "pwsh" || program === "powershell") return "powershell";
  if (program === "cmd") return "cmd";
  return "posix";
}

/**
 * The line that starts `provider`'s CLI: `binary` quoted for the shell, and — for Claude Code
 * only — `--resume` with the chat's session, so the terminal continues the very conversation the
 * chat was having.
 *
 * Resuming is offered only where it is a flag this app already passes to the same binary
 * (`claude.rs`) and the session is the system account's: a task run under another account keeps its
 * sessions in that account's folder, which a plain shell does not point the CLI at.
 */
export function cliLine(
  provider: string,
  binary: string,
  resume: { sessionId: string | null; accountId?: string | null },
  shell: CliShell,
  extra: {
    /** Claude Code's `--settings` file: the status hooks that tell the rail what it is doing. */
    settings?: string;
    /** Claude Code's `--append-system-prompt-file`: what `cf` is for, added to its system prompt. */
    noteFile?: string;
    /** The same note as text — Codex takes it as `developer_instructions`, beside its own. */
    note?: string;
    /** The first thing to ask, when the CLI takes it on its command line (see `promptInLine`). */
    prompt?: string;
  } = {},
): string {
  // Git Bash on Windows quotes as any POSIX shell: single quotes keep a `C:\…` path whole.
  const windows = shell !== "posix";
  const quoted = quotePath(binary, windows);
  // PowerShell runs a quoted string only through the call operator.
  const head = shell === "powershell" && quoted !== binary ? `& ${quoted}` : quoted;
  const parts = [head];
  if (provider === "claude" && extra.settings) parts.push(`--settings ${quotePath(extra.settings, windows)}`);
  if (provider === "claude" && extra.noteFile) parts.push(`--append-system-prompt-file ${quotePath(extra.noteFile, windows)}`);
  // A `-c` value that is not TOML is taken as a plain string — which the note, with no quotes in it,
  // always is; quoting it as TOML would need quotes that PowerShell mangles on the way to a program.
  if (provider === "codex" && extra.note) parts.push(`-c ${quotePath(`developer_instructions=${extra.note}`, windows)}`);
  if (canResume(provider, resume)) parts.push(`--resume ${quotePath(resume.sessionId ?? "", windows)}`);
  const prompt = extra.prompt?.trim() ?? "";
  if (prompt && promptInLine(provider, shell)) parts.push(quotePath(prompt, windows));
  return parts.join(" ");
}

/**
 * Whether `provider`'s CLI takes its first prompt as an argument: `claude "…"` and `codex "…"`
 * start the interactive session with it. The others are started bare and the prompt is typed in
 * once they are ready. Only in a POSIX shell: PowerShell expands `$` inside the double quotes `cmd`
 * needs, and a prompt is free text.
 */
export function promptInLine(provider: string, shell: CliShell): boolean {
  return shell === "posix" && (provider === "claude" || provider === "codex");
}

export function canResume(provider: string, resume: { sessionId: string | null; accountId?: string | null }): boolean {
  return provider === "claude" && !!resume.sessionId?.trim() && !(resume.accountId ?? "").trim();
}

/**
 * Whether `provider`'s CLI is told about `cf` on its command line (Claude's system-prompt file,
 * Codex's developer instructions). The rest have no flag that *adds* to their own instructions —
 * Grok's and Cline's replace them — so they get the note at the head of their first prompt instead.
 */
export function noteInLine(provider: string): boolean {
  return provider === "claude" || provider === "codex";
}

