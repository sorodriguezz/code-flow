import type { DiskVersion, EditorFile } from "./tauri/commands";

/**
 * What an editor tab holds when it is not simply a file's text — and how a read, a save or the
 * disk sweep turns into tab state.
 *
 * Pure on purpose: every rule here is one whose failure costs somebody their file (an error message
 * saved over the real contents, a Latin-1 file re-encoded, a save over an agent's work), and those
 * are rules to check directly rather than by clicking around the editor.
 */

/**
 * The prefix a checked save is refused with when the file changed on disk since it was read.
 * Mirrors `fsops::CHANGED_ON_DISK` — keep the two spellings in step.
 */
export const CHANGED_ON_DISK = "changed-on-disk";

/** Mirrors `fsops::MAX_EDITOR_READ_BYTES`: a text file past it can only have been opened with
 *  "open anyway", which is read-only. */
export const MAX_EDITOR_READ_BYTES = 20 * 1024 * 1024;

/** Whether a save failed because the file changed under the buffer — which is a question for the
 *  user, not an error to report. Matched anywhere in the text, so an `Error` wrapped around the
 *  backend's string ("Error: changed-on-disk: …") is still recognised. */
export function isChangedOnDisk(error: unknown): boolean {
  return String(error).includes(`${CHANGED_ON_DISK}: `);
}

/**
 * What a tab shows instead of an editor. Such a tab has no buffer at all — `content` stays empty
 * and never becomes dirty — which is the fix for the worst of these: an unreadable file used to open
 * as an ordinary tab *holding the error text*, one keystroke and a ⌘S away from writing that text
 * over the file it could not read.
 */
export type FileNotice =
  | { kind: "error"; message: string }
  | { kind: "binary"; size: number }
  | { kind: "image"; src: string; mime: string; size: number }
  | { kind: "tooLarge"; size: number; canForce: boolean };

/**
 * Why a tab shows text it will not save. `encoding`: decoded from something other than UTF-8, and
 * the editor only writes UTF-8 — a save would re-encode every accent. `large`: opened past the read
 * cap on request, where Monaco is at its limits and an accidental keystroke-and-save of a
 * hundred-megabyte log is not a thing to make easy.
 */
export type ReadOnlyReason = { kind: "encoding"; encoding: string } | { kind: "large" };

/** A read, as the tab fields it sets. */
export interface LoadedFile {
  /** The buffer — the file's text, or empty for a tab that shows a notice instead. */
  content: string;
  version: DiskVersion | null;
  notice: FileNotice | null;
  readOnly: ReadOnlyReason | null;
}

export function loadedFrom(file: EditorFile): LoadedFile {
  switch (file.kind) {
    case "text":
      return {
        content: file.text,
        version: file.version,
        notice: null,
        readOnly: file.version.size > MAX_EDITOR_READ_BYTES ? { kind: "large" } : null,
      };
    case "legacy":
      return {
        content: file.text,
        version: file.version,
        notice: null,
        readOnly: { kind: "encoding", encoding: file.encoding },
      };
    case "image":
      return {
        content: "",
        version: file.version,
        notice: { kind: "image", src: `data:${file.mime};base64,${file.base64}`, mime: file.mime, size: file.version.size },
        readOnly: null,
      };
    case "binary":
      return { content: "", version: file.version, notice: { kind: "binary", size: file.size }, readOnly: null };
    case "tooLarge":
      return {
        content: "",
        version: file.version,
        notice: { kind: "tooLarge", size: file.size, canForce: file.can_force },
        readOnly: null,
      };
  }
}

/** A read that failed, as a tab: the error is something to look at and retry, never a buffer. */
export function failedLoad(error: unknown): LoadedFile {
  return { content: "", version: null, notice: { kind: "error", message: String(error) }, readOnly: null };
}

/** Whether a tab holds a buffer that saving would write — not a notice, not read-only text. */
export function isWritable(tab: { notice: FileNotice | null; readOnly: ReadOnlyReason | null }): boolean {
  return tab.notice === null && tab.readOnly === null;
}

/**
 * Whether two versions describe the same bytes on disk.
 *
 * The hash decides. The timestamp is deliberately not part of it: a file rewritten with what it
 * already held — a checkout of an identical blob — has a new one and is the same file, and calling
 * that a change would reload clean tabs and flag dirty ones for nothing. A file too large to be
 * hashed is compared by its stamp, which is all there is of it.
 */
export function sameDiskContent(a: DiskVersion | null, b: DiskVersion | null): boolean {
  if (!a || !b) return a === b;
  if (a.size !== b.size) return false;
  if (a.hash || b.hash) return a.hash === b.hash;
  return a.mtime_ms === b.mtime_ms;
}

/**
 * Whether a read would change nothing a tab shows — what lets the disk sweep leave the tab list
 * alone. The tab list is what every pane (each a live Monaco) and the file tree render from, so a
 * sweep that rebuilt it for a file that came back the same re-rendered all of them for nothing.
 */
export function sameLoadedState(
  tab: { version: DiskVersion | null; notice: FileNotice | null; readOnly: ReadOnlyReason | null },
  loaded: LoadedFile,
): boolean {
  return (
    sameDiskContent(tab.version, loaded.version) &&
    tab.notice?.kind === loaded.notice?.kind &&
    (tab.notice?.kind !== "error" ||
      loaded.notice?.kind !== "error" ||
      tab.notice.message === loaded.notice.message) &&
    tab.readOnly?.kind === loaded.readOnly?.kind
  );
}

/**
 * What the disk sweep does to one open tab, given the version on disk now (`null`: nothing there).
 *
 * - `mark`: a **dirty** tab is never reloaded — the user's edit wins until they decide — but it is
 *   flagged when its file changed under it (and unflagged when the change goes away), so the question
 *   a save would ask is visible before it is asked.
 * - `stamp`: the same bytes under a newer timestamp (an identical blob checked out). Nothing to show,
 *   but the stamp is kept, so the next sweep of the file is a bare `stat` again.
 * - `reload`: a clean tab whose file changed — or a notice whose file appeared, changed or went.
 * - `none`: the overwhelmingly common answer, and the one that must not touch the tab list at all.
 *
 * A clean text tab whose file is gone keeps what it last read: there is nothing to reload, and a save
 * would ask first.
 */
export type SweepStep =
  | { kind: "none" }
  | { kind: "mark"; diskChanged: boolean; version: DiskVersion | null }
  | { kind: "stamp"; version: DiskVersion }
  | { kind: "reload" };

export function sweepStep(
  tab: { version: DiskVersion | null; notice: FileNotice | null; diskChanged: boolean },
  dirty: boolean,
  now: DiskVersion | null,
): SweepStep {
  const unchanged = sameDiskContent(now, tab.version);
  const restamped = unchanged && now !== null && tab.version !== null && now.mtime_ms !== tab.version.mtime_ms;
  if (dirty) {
    if (tab.diskChanged === !unchanged && !restamped) return { kind: "none" };
    return { kind: "mark", diskChanged: !unchanged, version: restamped ? now : tab.version };
  }
  if (unchanged) return restamped && now ? { kind: "stamp", version: now } : { kind: "none" };
  if (now === null && tab.notice === null) return { kind: "none" };
  return { kind: "reload" };
}

/** What the unsaved-work question lists for a path: the file's name, and the folder it is in when
 *  it has one. */
export function describePath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? { name: path, dir: "" } : { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}
