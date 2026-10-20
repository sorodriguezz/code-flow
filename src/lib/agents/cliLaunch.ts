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
  windows: boolean,
  extra: {
    /** Claude Code's `--settings` file: the status hooks that tell the rail what it is doing. */
    settings?: string;
    /** The first thing to ask, when the CLI takes it on its command line (see `promptInLine`). */
    prompt?: string;
  } = {},
): string {
  const quoted = quotePath(binary, windows);
  // PowerShell runs a quoted string only through the call operator.
  const head = windows && quoted !== binary ? `& ${quoted}` : quoted;
  const parts = [head];
  if (provider === "claude" && extra.settings) parts.push(`--settings ${quotePath(extra.settings, windows)}`);
  if (canResume(provider, resume)) parts.push(`--resume ${quotePath(resume.sessionId ?? "", windows)}`);
  const prompt = extra.prompt?.trim() ?? "";
  if (prompt && promptInLine(provider, windows)) parts.push(quotePath(prompt, windows));
  return parts.join(" ");
}

/**
 * Whether `provider`'s CLI takes its first prompt as an argument: `claude "…"` and `codex "…"`
 * start the interactive session with it. The others are started bare and the prompt is typed in
 * once they are ready. Never on Windows: PowerShell expands `$` inside the double quotes `cmd`
 * needs, and a prompt is free text.
 */
export function promptInLine(provider: string, windows: boolean): boolean {
  return !windows && (provider === "claude" || provider === "codex");
}

export function canResume(provider: string, resume: { sessionId: string | null; accountId?: string | null }): boolean {
  return provider === "claude" && !!resume.sessionId?.trim() && !(resume.accountId ?? "").trim();
}
