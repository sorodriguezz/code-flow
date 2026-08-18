import { AI_PROVIDERS } from "./aiProviders";

/**
 * Which coding agent, if any, is being run in a terminal — read from the line the user typed.
 *
 * # Why the typed line and not the process table
 *
 * The honest answer to "what is running in this pty" is the foreground process group, and getting it
 * means platform-specific calls in the backend for every session on a timer. The question being
 * answered here is much smaller: *you just typed `claude`*, so the tab should say so. A typed line
 * is already reconstructed for the command history (`TypedLineBuffer` in `TerminalPane`), arrives
 * exactly once per command, and costs nothing.
 *
 * What it misses is worth stating: a command recalled with the up arrow, or pasted, never passes
 * through the keystroke buffer, so the badge will not appear for it. That is a missing badge, not a
 * wrong one — and a wrong one is the failure that would matter, since the point of the mark is to
 * tell four identical-looking shells apart at a glance.
 *
 * # The binaries come from the provider catalogue
 *
 * `agy` is Gemini's, `codex` is OpenAI's — knowing that is exactly what `AI_PROVIDERS` is for, and
 * duplicating the mapping here would let the two drift the next time a CLI is renamed, which has
 * already happened once (`gemini` became `agy`).
 */

/** Binary → provider id, built once from the catalogue.
 *
 * `defaultBinary` is optional on the option type — an HTTP provider puts its endpoint there and some
 * have none — so entries without one are dropped rather than mapped from `undefined`, which would
 * make every unrecognised command match the last such provider. */
const BY_BINARY = new Map<string, string>(
  AI_PROVIDERS.flatMap((provider) =>
    provider.defaultBinary ? [[provider.defaultBinary, provider.id] as [string, string]] : [],
  ),
);

/**
 * Leading environment assignments and `sudo`-style prefixes, skipped so `FOO=bar claude` is still
 * recognised as claude. Deliberately short: this is a nicety, not a shell parser, and anything it
 * fails to see through simply leaves the tab unmarked.
 */
const PREFIXES = new Set(["sudo", "env", "nohup", "command", "time"]);

/**
 * The agent a command line starts, or `null`.
 *
 * `null` is also the answer for a bare `cd` or `ls` — only a line that *starts* an agent marks the
 * tab, and any other command leaves the previous mark alone rather than clearing it. A shell where
 * you run `claude`, quit it and run `ls` is still the shell you were using claude in.
 */
export function agentFromCommand(line: string): string | null {
  const words = line.trim().split(/\s+/).filter(Boolean);
  let at = 0;
  // Step over `VAR=value` assignments and the handful of wrappers above.
  while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]) || PREFIXES.has(words[at]))) {
    at += 1;
  }
  const command = words[at];
  if (!command) return null;
  // A path-qualified binary counts: `./node_modules/.bin/claude` and `/usr/local/bin/agy` are the
  // same tool, and on Windows the same name arrives with an extension.
  const leaf = command.split(/[/\\]/).pop()?.replace(/\.(exe|cmd|bat|ps1)$/i, "") ?? "";
  return BY_BINARY.get(leaf) ?? null;
}
