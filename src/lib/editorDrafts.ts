import { getSetting, setSetting } from "./tauri/commands";

/**
 * Unsaved editor buffers, kept somewhere that survives the process dying.
 *
 * The editor has no autosave — `save` is the only writer and it has exactly two call sites — so
 * until this existed, anything typed and not saved was lost outright when the app was force-quit
 * after a hang, when the webview's render process died, or when a panic took the process down.
 * There was no journal, no recovery prompt, and nothing on next launch even hinted that work had
 * been in flight.
 *
 * This is deliberately **not** autosave. Nothing is ever written to the user's file: the drafts go
 * into the app's own settings row, they are offered back on the next launch, and the buffer stays
 * dirty until the user saves it themselves. A tool that silently wrote to disk on a timer would be
 * a different, larger promise — one that a git client, of all things, should not make quietly.
 */

/** One row per repository, so opening a different project cannot resurrect another one's drafts. */
function keyFor(repoPath: string): string {
  return `editor_drafts:${repoPath}`;
}

export interface EditorDraft {
  path: string;
  content: string;
  /** Epoch ms, so the restore notice can say how old the work is. */
  at: number;
}

/**
 * Ceiling per file. Well past anything hand-edited, and low enough that a generated file someone
 * opened and touched cannot put a megabyte into a settings row that is read synchronously at boot.
 * A buffer over the cap is skipped rather than truncated — half a file offered back as if it were
 * whole is worse than admitting it was not kept.
 */
const MAX_DRAFT_BYTES = 512 * 1024;

/** Ceiling across all of them, for the same reason. Oldest are dropped first. */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * How long a draft is worth offering back.
 *
 * A week. Past that the user has almost certainly moved on, and restoring a buffer they last
 * touched a fortnight ago — against a file that has since changed underneath it — is a surprise
 * rather than a rescue.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function readDrafts(repoPath: string, now: number): Promise<EditorDraft[]> {
  const raw = await getSetting(keyFor(repoPath)).catch(() => null);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is EditorDraft => {
      if (!entry || typeof entry !== "object") return false;
      const draft = entry as Record<string, unknown>;
      return (
        typeof draft.path === "string" &&
        typeof draft.content === "string" &&
        typeof draft.at === "number" &&
        now - draft.at < MAX_AGE_MS
      );
    });
  } catch {
    // A corrupted row is not worth a diagnostic: there is nothing the user could do about it, and
    // the honest outcome is the same as having no drafts.
    return [];
  }
}

/**
 * Replaces the stored drafts for one repository.
 *
 * Whole-list rather than per-file, because "which files are dirty" is itself the state being
 * recorded — a file that stopped being dirty has to *leave*, and a per-file write cannot express
 * that without a second delete call it would be easy to forget.
 */
export async function writeDrafts(repoPath: string, drafts: EditorDraft[]): Promise<void> {
  const kept: EditorDraft[] = [];
  let total = 0;
  // Newest first, so the total cap drops the oldest work rather than the work in progress.
  for (const draft of [...drafts].sort((a, b) => b.at - a.at)) {
    const size = draft.content.length;
    if (size > MAX_DRAFT_BYTES || total + size > MAX_TOTAL_BYTES) continue;
    total += size;
    kept.push(draft);
  }
  await setSetting(keyFor(repoPath), JSON.stringify(kept)).catch(() => {});
}

export async function clearDrafts(repoPath: string): Promise<void> {
  await setSetting(keyFor(repoPath), "[]").catch(() => {});
}
