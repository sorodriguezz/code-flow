import type { FileEntry } from "../types/domain";
import { splitPath } from "./splitPath";

/**
 * Reading the scripts out of a `package.json`, and deciding which of them may be typed into a
 * shell.
 *
 * # Why the name is validated rather than quoted
 *
 * A script name comes off disk. `"build; rm -rf ~"` is a perfectly legal JSON key, and the row that
 * draws it ends with the app writing a line into a live pty — so the name is untrusted input on its
 * way into a command interpreter, which is the shape of every shell-injection bug ever filed.
 *
 * The reflex is to quote it. That does not work here, and the reason is worth writing down so
 * nobody "fixes" it back: the terminal dock does not own its shell. `shell_profiles.rs` detects
 * whatever is on the machine and the user picks a default — zsh, bash and fish on Unix, but also
 * PowerShell and **cmd.exe** on Windows, plus any custom profile someone typed a path into. Those
 * three families have no quoting syntax in common. `'x'` is a quoted string in POSIX shells, a
 * quoted string in PowerShell, and in cmd.exe it is the literal five characters — the quotes are
 * part of the argument. Escaping is worse: `\` escapes in POSIX, backtick escapes in PowerShell,
 * `^` escapes in cmd. Any single escaping function this module could export would be correct for
 * one of the shells the app can spawn and silently wrong for the other two, and "silently wrong"
 * in this context means the injection still runs.
 *
 * So the containment is a whitelist instead. Only names made entirely of characters that are inert
 * in *all three* families are ever typed; anything else is drawn with an inert play button and a
 * tooltip that says why. It costs a few real-world script names their button — nobody has ever
 * shipped one — and in exchange there is no shell-specific escaping to get wrong.
 *
 * **The script's body is never typed.** Only `npm run <name>` reaches the terminal; the package
 * manager is the thing that reads the body out of the JSON and runs it, exactly as it would from a
 * shell prompt. That is what keeps the surface down to the name.
 */

export type PackageManager = "pnpm" | "yarn" | "npm";

/**
 * The managers, in the order the picker lists them — and, not coincidentally, the order detection
 * breaks a tie in.
 *
 * npm is last on purpose. A repository with two lockfiles is usually a repository where someone ran
 * a bare `npm install` by muscle memory in a pnpm or yarn project and committed the `package-lock.json`
 * it left behind; the deliberate lockfile is almost always the other one. Ranking npm below the two
 * that had to be chosen on purpose makes the common accident cost nothing.
 */
export const PACKAGE_MANAGERS: readonly PackageManager[] = ["pnpm", "yarn", "npm"];

/** The file each manager writes, and the only evidence detection has to go on. */
export const LOCKFILE: Record<PackageManager, string> = {
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
  npm: "package-lock.json",
};

export const PACKAGE_JSON = "package.json";

/** Exact name, not a suffix match: `package.json.bak` and `old-package.json` are not manifests, and
 *  offering to run scripts out of them would be offering to run something that isn't there. */
export function isPackageJson(entry: FileEntry): boolean {
  return !entry.is_dir && entry.name === PACKAGE_JSON;
}

export interface PackageScript {
  name: string;
  /** The body declared in the JSON. Shown, dimmed, so the row says what it will actually do — but
   *  never typed anywhere: see this module's header. */
  command: string;
  /** Whether `name` cleared the whitelist. False rows are still drawn, just inert. */
  runnable: boolean;
}

export type PackageScriptsState =
  | { status: "loading" }
  | { status: "ok"; scripts: PackageScript[] }
  | { status: "invalid" }
  | { status: "unreadable"; error: string };

/**
 * The whitelist.
 *
 * Every character here is inert in POSIX shells, PowerShell and cmd.exe alike. What is deliberately
 * *outside* it is the interesting half: `;` `&` `|` `$` `` ` `` `(` `)` `<` `>` `'` `"` `\` `*` `?`
 * `~` `!` `%` `^` `#` `{` `}` `[` `]` `=` `,` and the space. Between them those cover command
 * separation, subshells and substitution, redirection, quoting, escaping, globbing, home expansion,
 * history expansion, cmd's `%VAR%` and its `^` escape — i.e. every way a name could stop being an
 * argument and start being syntax. The space is out too: without it a name cannot grow a second
 * word, so `pnpm run <name>` stays three tokens no matter what the file says.
 *
 * The first character must be alphanumeric, which is a separate concern from injection. A name
 * beginning with `-` is not dangerous, it is *misread*: npm, pnpm and yarn would take `-f` as their
 * own flag rather than as the script to run, so the line would do something other than what the row
 * promises. Better to refuse it than to run the wrong thing.
 *
 * 128 characters is a limit on nothing in particular — a package manager takes longer names — and
 * exists only so a pathological generated manifest cannot put a kilobyte-long token on the prompt.
 */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;

export function isRunnableScriptName(name: string): boolean {
  return SCRIPT_NAME.test(name);
}

/**
 * `package.json` text to rows.
 *
 * The three failure shapes are kept apart because they mean different things to the person looking
 * at the tree: a file that is not JSON is something they can go and fix, a file with no `scripts`
 * block is fine and simply has nothing to offer, and neither should read as the app having broken.
 *
 * Declaration order is preserved rather than sorted. The order in a manifest is written by hand and
 * carries intent — `dev`, `build`, `test` at the top, the twelve `ci:*` entries at the bottom — and
 * alphabetising it would bury the two scripts anyone actually clicks under the ones nobody does.
 *
 * A non-string value is dropped rather than failing the parse, the same call `hiddenFilesStore.parse`
 * makes about a malformed row: one bad entry costs its own row, not the whole list.
 */
export function parsePackageScripts(raw: string): PackageScriptsState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { status: "invalid" };
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return { status: "ok", scripts: [] };
  }
  const rows: PackageScript[] = [];
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== "string") continue;
    rows.push({ name, command, runnable: isRunnableScriptName(name) });
  }
  return { status: "ok", scripts: rows };
}

/**
 * Which manager this `package.json` belongs to, going by the nearest lockfile at or above it.
 *
 * **No backend call, by construction.** `listings` is the tree's own `listDir` cache, and for a
 * `package.json` row to be on screen at all the explorer must already have listed the directory it
 * sits in and every directory above it — that is what the user clicked through to get there. So the
 * walk up to the root is a handful of `Map` lookups against listings that are already in memory, and
 * clicking a chevron never turns into a burst of filesystem round trips.
 *
 * It must be handed the **unfiltered** cache, not the one the explorer draws from. A lockfile is
 * precisely the kind of row people hide — it is noise they never open — and hiding a row is a
 * statement about what the tree draws, not about which package manager the repository uses. Passing
 * the filtered map would make `pnpm-lock.yaml` disappearing from view silently switch the buttons
 * over to npm.
 *
 * Nearest wins over the root: a workspace package with its own lockfile has genuinely opted out of
 * the monorepo's manager, and it is the one standing closest to the file.
 */
export function detectPackageManager(
  dir: string,
  listings: Map<string, FileEntry[]>,
): PackageManager | null {
  return detectPackageManagers(dir, listings)[0] ?? null;
}

/**
 * **Every** manager whose lockfile sits at the nearest level that has one.
 *
 * The singular version above answers with the first of these and says nothing about the rest, which
 * is wrong whenever a repository carries more than one lockfile — and that happens: somebody runs
 * `npm install` in a pnpm project, a migration leaves the old file behind, a template ships with
 * two. Picking one silently means the play button runs a different manager from the one the person
 * pressing it expects, and the failure is quiet — a lockfile gets rewritten by the wrong tool.
 *
 * Stops at the first directory that has any, rather than collecting all the way up: a workspace
 * package with its own lockfile has genuinely opted out of the monorepo's manager, and mixing the
 * two levels would offer a choice that is not really open.
 *
 * Ordered by `PACKAGE_MANAGERS`, so a caller that just takes the first gets a stable answer rather
 * than one that depends on how the directory happened to be listed.
 */
export function detectPackageManagers(
  dir: string,
  listings: Map<string, FileEntry[]>,
): PackageManager[] {
  let current = dir;
  for (;;) {
    const entries = listings.get(current);
    if (entries) {
      const names = new Set(entries.filter((entry) => !entry.is_dir).map((entry) => entry.name));
      const found = PACKAGE_MANAGERS.filter((manager) => names.has(LOCKFILE[manager]));
      if (found.length > 0) return found;
    }
    if (current === "") return [];
    current = splitPath(current).dir;
  }
}

/**
 * The yarn subcommands a script name can collide with.
 *
 * Yarn's short form — `yarn build` — is the one everybody types, and it is what the tooltip should
 * show for a script called `build`. But it is only shorthand for "run this script *if no subcommand
 * owns the word*". A manifest is free to declare a script called `install`, and `yarn install`
 * installs dependencies; the script would never run and the row would have lied. So the short form
 * is used everywhere except the words yarn has already spoken for, where it falls back to the
 * explicit `yarn run <name>`.
 */
const YARN_BUILTINS: ReadonlySet<string> = new Set([
  "install",
  "add",
  "remove",
  "up",
  "upgrade",
  "why",
  "init",
  "link",
  "unlink",
  "pack",
  "publish",
  "run",
  "test",
  "node",
  "dlx",
  "exec",
  "workspace",
  "workspaces",
  "set",
  "config",
  "cache",
  "bin",
  "create",
  "info",
  "plugin",
  "patch",
  "rebuild",
  "version",
]);

/**
 * The exact line to type, or `null` for a name that must never be typed.
 *
 * The whitelist is checked again here even though the UI has already greyed those rows out. This is
 * the single place a script name is turned into a command line, so it is the place worth defending:
 * a future caller that forgets the `runnable` flag gets `null` and no command, rather than a shell
 * and an injection. A check the caller cannot skip is worth more than one it is asked to remember.
 */
export function scriptCommandLine(manager: PackageManager, name: string): string | null {
  if (!isRunnableScriptName(name)) return null;
  switch (manager) {
    case "npm":
      return `npm run ${name}`;
    case "pnpm":
      return `pnpm run ${name}`;
    case "yarn":
      return YARN_BUILTINS.has(name) ? `yarn run ${name}` : `yarn ${name}`;
  }
}

/**
 * A package name, by npm's own grammar, checked before it can become a shell word.
 *
 * The mirror of `isRunnableScriptName`, and here for the identical reason: a name that reaches this
 * app arrives from somewhere it did not write — a registry search, or a `package.json` on disk — and
 * `install` is a line typed at a prompt. Nothing outside this set can end a command, open a
 * subshell, redirect, glob or expand, so `pnpm add <name>` stays three tokens whatever the name says.
 *
 * Kept as a second lock even though `src-tauri/src/npm.rs` applies the same rule before a name ever
 * comes back from a search: that one guards a URL, this one guards a shell, and neither should
 * depend on the other having run.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function isInstallableName(name: string): boolean {
  return name.length <= 214 && PACKAGE_NAME.test(name);
}

/**
 * The line that installs a package, or `null` when the name is not one this will type.
 *
 * `add` in all three: npm has understood it as an alias for `install` since v7, and using the one
 * word everywhere means the command the terminal shows matches what the dialog said it would run,
 * whichever manager the repository uses.
 */
export function addCommandLine(
  manager: PackageManager,
  name: string,
  dev: boolean,
): string | null {
  if (!isInstallableName(name)) return null;
  // Each manager spells the dev flag differently, and the long forms are the ones that read as what
  // they do in a transcript somebody scrolls back through a week later.
  const flag = dev ? (manager === "npm" ? " --save-dev" : " --dev") : "";
  return `${manager} add ${name}${flag}`;
}

/**
 * How many script rows a manifest gets before the rest go behind a "show the others" row.
 *
 * The tree is not virtualised: every row it draws is a live DOM node. A generated manifest with two
 * hundred `ci:*` entries would put two hundred nodes into a tree that may already be drawing several
 * hundred, in one click, and the interesting scripts are always near the top anyway.
 */
export const SCRIPT_ROW_CAP = 40;
