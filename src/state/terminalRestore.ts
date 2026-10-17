/**
 * What the dock keeps of a repository's terminals across a restart: each tab's name, look, profile
 * and the folder its shell was last in, how they were split, and the tail of what each printed.
 *
 * A shell does not survive the app — its process ends with it — so what comes back is a *new*
 * shell in the same place, under the same name, with the old output reprinted dimmed above a
 * "restored session" line. Plain text, not the raw bytes: the record is read back as history, and
 * colour codes and cursor moves from a dead session would only fight the live one.
 */
import type { TerminalGroup } from "./terminalLayout";

export interface SavedTab {
  title: string;
  cwd: string;
  profileId?: string;
  color?: string;
  icon?: string;
  text?: string;
}

export interface SavedGroup {
  /** Indexes into `tabs`. */
  tabs: number[];
  dir: "row" | "column";
  sizes: number[];
  broadcast: boolean;
}

export interface SavedProject {
  tabs: SavedTab[];
  groups: SavedGroup[];
  focused: number;
}

export interface SavedDock {
  v: 1;
  projects: Record<string, SavedProject>;
}

/** Lines of output kept per terminal — the end of it, where the last command and its answer are. */
export const KEPT_LINES = 400;
/** And per terminal in characters, so one tab of minified JSON cannot make the row huge. */
export const KEPT_CHARS = 60_000;

export function parseSavedDock(raw: string | null): SavedDock {
  try {
    const value = raw ? (JSON.parse(raw) as SavedDock) : null;
    if (value && value.v === 1 && value.projects && typeof value.projects === "object") return value;
  } catch {
    // A corrupt row is no terminals to restore, never a broken dock.
  }
  return { v: 1, projects: {} };
}

/** The last `KEPT_LINES` lines of `text`, trailing blank lines dropped, capped in characters. */
export function tailOf(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const tail = lines.slice(-KEPT_LINES).join("\n");
  return tail.length > KEPT_CHARS ? tail.slice(-KEPT_CHARS) : tail;
}

interface LiveTab {
  id: string;
  title: string;
  cwd: string;
  liveCwd?: string;
  profileId?: string;
  color?: string;
  icon?: string;
}

/** A repository's terminals as they stand now, in the shape that is saved. */
export function snapshotProject(
  tabs: LiveTab[],
  groups: TerminalGroup[],
  focusedId: string | null,
  read: (id: string) => string | null,
): SavedProject {
  const index = new Map(tabs.map((tab, at) => [tab.id, at]));
  return {
    tabs: tabs.map((tab) => {
      const text = read(tab.id);
      return {
        title: tab.title,
        cwd: tab.liveCwd || tab.cwd,
        ...(tab.profileId ? { profileId: tab.profileId } : {}),
        ...(tab.color ? { color: tab.color } : {}),
        ...(tab.icon ? { icon: tab.icon } : {}),
        ...(text ? { text: tailOf(text) } : {}),
      };
    }),
    groups: groups
      .map((group) => ({
        tabs: group.ids.map((id) => index.get(id)).filter((at): at is number => at !== undefined),
        dir: group.dir,
        sizes: group.sizes,
        broadcast: group.broadcast,
      }))
      .filter((group) => group.tabs.length > 0),
    focused: focusedId ? (index.get(focusedId) ?? 0) : 0,
  };
}

/**
 * What a restored pane prints before its new shell's first prompt: the old output dimmed, then a
 * rule saying where the old session ends. `\r\n`, because a terminal's newline does not return.
 */
export function replayText(text: string | undefined, label: string): string {
  const rule = `\x1b[2m── ${label} ──\x1b[0m\r\n`;
  if (!text) return "";
  return `\x1b[2m${text.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n${rule}`;
}
