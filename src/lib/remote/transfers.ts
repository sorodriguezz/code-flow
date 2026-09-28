/**
 * What a file transfer does when its destination is already taken — asked, never assumed.
 *
 * Every transport's write truncates whatever is at the destination, so an upload onto an existing
 * name used to replace it without a word. The browsers now ask first, and this is the part of that
 * with no UI in it: which items collide (the backend checks, against the service rather than a
 * listing that may be stale or one page of many), how the answers apply, and what "keep both"
 * renames a copy to. The questions themselves are handed in, so the rules can be tested without a
 * dialog.
 *
 * **The answer for a folder applies to what is inside it.** Replace merges — files with the same
 * name are overwritten, nothing else on the far side is touched — Skip leaves the folder alone, and
 * Keep both copies it beside the original under a new name.
 */

/** What a cancelled transfer rejects with. Keep identical to `TRANSFER_CANCELLED` in
 *  `src-tauri/src/remotes/files.rs`: the browsers match it to stay quiet about a stop the user asked for. */
export const TRANSFER_CANCELLED = "Transfer cancelled.";

/** What typing a password is refused with when the session is not at a password prompt. Keep
 *  identical to `NOT_ASKING` in `src-tauri/src/remotes/session.rs`. */
export const NOT_ASKING = "This session isn't asking for a password right now.";

export const isCancelled = (error: unknown): boolean => String(error).includes(TRANSFER_CANCELLED);

export const isNotAsking = (error: unknown): boolean => String(error).includes(NOT_ASKING);

export type ConflictChoice = "replace" | "skip" | "keep";

/** One thing to move, and the directory it is going into. */
export interface TransferItem {
  /** Where it comes from — a local or a remote path, whichever side it starts on. */
  source: string;
  name: string;
  isDir: boolean;
  /** The destination directory. */
  dir: string;
}

/** A transfer that is going ahead, and exactly where it lands. */
export interface ResolvedTransfer extends TransferItem {
  dest: string;
}

export interface ConflictQuestions {
  /** Several items collide: one answer for all of them, `"each"` to decide one by one, `null` to call
   *  the whole transfer off. */
  all: (names: string[]) => Promise<ConflictChoice | "each" | null>;
  /** One item collides. `null` calls off the whole transfer — someone who backs out of the question
   *  about the first file has not agreed to the rest. */
  one: (item: TransferItem) => Promise<ConflictChoice | null>;
}

/**
 * The name a copy gets when the user keeps both: `report (1).pdf`, `photos (1)`.
 *
 * The number goes before the extension, so the copy still opens with what the original opens
 * with — and before a compound `.tar.*`, which is one extension to everything that reads it. A
 * folder has no extension, and neither does a dot-file whose only dot is its first character.
 */
export function keepBothName(name: string, n: number, isDir: boolean): string {
  if (isDir) return `${name} (${n})`;
  const compound = /^(.+?)(\.tar\.[^.]+)$/i.exec(name);
  if (compound) return `${compound[1]} (${n})${compound[2]}`;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

/** How many numbered names are tried before "keep both" gives up on an item. */
const KEEP_BOTH_TRIES = 20;

/**
 * Works out what a transfer of `items` actually does, asking where it has to.
 *
 * Resolves to the transfers to run — skipped items left out, kept-both ones renamed — or `null`
 * when the user called it off. `exists` answers for a batch of destination paths at once, and
 * `join` builds a path the way this side of the transfer spells them.
 */
export async function resolveTransfers(
  items: TransferItem[],
  exists: (paths: string[]) => Promise<boolean[]>,
  ask: ConflictQuestions,
  join: (dir: string, name: string) => string,
): Promise<ResolvedTransfer[] | null> {
  const planned: ResolvedTransfer[] = items.map((item) => ({ ...item, dest: join(item.dir, item.name) }));
  if (planned.length === 0) return [];
  const taken = await exists(planned.map((item) => item.dest));
  const clashing = planned.filter((_, at) => taken[at]);
  if (clashing.length === 0) return planned;

  const choices = new Map<ResolvedTransfer, ConflictChoice>();
  if (clashing.length === 1) {
    const choice = await ask.one(clashing[0]);
    if (choice === null) return null;
    choices.set(clashing[0], choice);
  } else {
    const all = await ask.all(clashing.map((item) => item.name));
    if (all === null) return null;
    for (const item of clashing) {
      const choice = all === "each" ? await ask.one(item) : all;
      if (choice === null) return null;
      choices.set(item, choice);
    }
  }

  const renamed = new Map<ResolvedTransfer, ResolvedTransfer>();
  const keep = clashing.filter((item) => choices.get(item) === "keep");
  if (keep.length > 0) {
    // Every candidate for every kept item in one round trip, rather than one per guess.
    const candidates = keep.flatMap((item) =>
      Array.from({ length: KEEP_BOTH_TRIES }, (_, at) => join(item.dir, keepBothName(item.name, at + 1, item.isDir))),
    );
    const found = await exists(candidates);
    const claimed = new Set<string>();
    keep.forEach((item, index) => {
      for (let at = 0; at < KEEP_BOTH_TRIES; at += 1) {
        const candidate = candidates[index * KEEP_BOTH_TRIES + at];
        if (!found[index * KEEP_BOTH_TRIES + at] && !claimed.has(candidate)) {
          claimed.add(candidate);
          renamed.set(item, { ...item, name: keepBothName(item.name, at + 1, item.isDir), dest: candidate });
          return;
        }
      }
      // Twenty copies already: this one is not worth a twenty-first guess — it is skipped.
      choices.set(item, "skip");
    });
  }

  return planned
    .filter((item) => choices.get(item) !== "skip")
    .map((item) => renamed.get(item) ?? item);
}
