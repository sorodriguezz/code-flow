import { agentLaunchFiles, getSetting, listShellProfiles, terminalSetAgent, writeTerminal } from "../tauri/commands";
import { AI_PROVIDERS } from "../aiProviders";
import { currentPlatform } from "../platform";
import { useBenchStore } from "../../state/benchStore";
import { useTerminalAgentStore } from "../../state/terminalAgentStore";
import { cliLine, noteInLine, promptInLine, shellFamily, type CliShell } from "./cliLaunch";

/**
 * Starts an agent's own CLI in a new terminal of the bench, standing in `path` — what every «run
 * this agent here» in the «Worktrees» layout does.
 *
 * The terminal is an ordinary bench shell: it is also listed on the bench, keeps running when the
 * view is left, and its agent is followed by the backend like any other (`agentstatus.rs`). This
 * only adds what a launch knows and a hand-typed command does not:
 *
 * - **who it is**, said to the backend before the program prints anything, so the card shows the
 *   agent from the first frame;
 * - **Claude Code's status hooks** (`--settings`), which add its prompt and its reply to the card;
 * - **what `cf` is for**, so the agent asks before anything irreversible and says when it is done —
 *   on the command line for Claude and Codex, at the head of the first prompt for the rest;
 * - **the first prompt** — on the command line where the CLI takes one (`promptInLine`), otherwise
 *   typed in once the program has drawn itself and gone quiet.
 */
export async function startAgentCli(options: {
  workspaceId: string;
  path: string;
  provider: string;
  /** The tab's name. */
  title: string;
  prompt?: string;
  resume?: { sessionId: string | null; accountId?: string | null };
}): Promise<{ terminalId: string; sessionId: string } | null> {
  const { workspaceId, path, provider, title } = options;
  const shell = await defaultShell();
  const stored = (await getSetting(`${provider}_binary_path`).catch(() => null))?.trim() ?? "";
  const binary = stored || AI_PROVIDERS.find((candidate) => candidate.id === provider)?.defaultBinary || provider;
  // Missing files cost the card its prompt and reply, and the agent its note on `cf` — not the launch.
  const files = await agentLaunchFiles().catch(() => ({ settings: "", note_file: "", note: "" }));
  const asked = options.prompt?.trim() ?? "";
  // No flag adds to these CLIs' own instructions, so the note rides at the head of the first prompt.
  const prompt = asked && files.note && !noteInLine(provider) ? `${files.note}\n\n${asked}` : asked;
  const line = cliLine(provider, binary, options.resume ?? { sessionId: null }, shell, {
    settings: files.settings,
    noteFile: files.note_file,
    note: files.note,
    prompt,
  });

  const bench = useBenchStore.getState();
  await bench.addTab(workspaceId, path);
  const tabId = useBenchStore.getState().activeTabId;
  const terminalId = tabId ? useBenchStore.getState().focusedPane[tabId] : "";
  if (!tabId || !terminalId) return null;
  await bench.renameTab(tabId, title).catch(() => undefined);
  await bench.renameTerminal(terminalId, title).catch(() => undefined);
  // Into the shell's session — `write_terminal` takes the pty's id, not the bench row's — with a
  // carriage return, as a pty receives Enter (see `benchStore.runPanes`).
  const sessionId = useBenchStore.getState().terminals.find((terminal) => terminal.id === terminalId)?.session_id ?? "";
  if (!sessionId) return null;
  await terminalSetAgent(sessionId, provider).catch(() => false);
  await writeTerminal(sessionId, `${line}\r`);
  if (prompt && !promptInLine(provider, shell)) typeWhenReady(sessionId, prompt);
  return { terminalId, sessionId };
}

/**
 * The family of the shell a new bench tab opens: on Windows the default profile's — Git Bash unless
 * Settings › Terminal picks another, as `shell_profiles::resolve` decides — and POSIX elsewhere.
 */
async function defaultShell(): Promise<CliShell> {
  if (currentPlatform() !== "windows") return "posix";
  const [profiles, configured] = await Promise.all([
    listShellProfiles().catch(() => []),
    getSetting("terminal_default_profile").catch(() => null),
  ]);
  const profile = profiles.find((p) => p.id === configured) ?? profiles.find((p) => p.id === "git-bash") ?? profiles[0];
  return profile ? shellFamily(profile.command) : "posix";
}

/** How long a CLI gets to draw itself before the prompt is typed anyway. */
const READY_LIMIT_MS = 20_000;
/** A program that has not printed anything yet is not ready, however quiet it is. */
const READY_FLOOR_MS = 1_500;

/**
 * Types `prompt` into an agent's TUI once it is ready for it: it has drawn itself (the backend saw
 * it write) and gone quiet (it reports anything but working). One line — a newline typed into a TUI
 * is Enter, and would send half the prompt — and Enter a moment later, on its own, so it is not
 * taken for part of a paste.
 */
function typeWhenReady(sessionId: string, prompt: string): void {
  const started = Date.now();
  let sawWork = false;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.clearInterval(poll);
    window.clearTimeout(limit);
    void writeTerminal(sessionId, prompt.replace(/\s*\n\s*/g, " ")).then(() =>
      window.setTimeout(() => void writeTerminal(sessionId, "\r").catch(() => undefined), 150),
    );
  };
  const check = () => {
    const agent = useTerminalAgentStore.getState().agents[sessionId];
    if (agent?.state === "working") sawWork = true;
    const settled = agent?.state && agent.state !== "working";
    if (settled && (sawWork || Date.now() - started > 3 * READY_FLOOR_MS) && Date.now() - started > READY_FLOOR_MS) finish();
  };
  // Looked at on a short interval rather than on store changes: "quiet for long enough" is a matter
  // of time passing, which no event announces. It lives for seconds, once per launch.
  const poll = window.setInterval(check, 300);
  const limit = window.setTimeout(finish, READY_LIMIT_MS);
}
