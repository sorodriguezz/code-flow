import { useEffect, useState } from "react";
import { listDir } from "./tauri/commands";
import { detectPackageManagers, type PackageManager } from "./packageScripts";
import { usePackageManagerStore } from "../state/packageManagerStore";
import type { FileEntry } from "../types/domain";

/**
 * Which package manager a directory belongs to, for callers that are not the file tree.
 *
 * # Why this exists next to the tree's own answer
 *
 * `FileTree` resolves this from `childrenRef` — its `listDir` cache — and the note on
 * `detectPackageManager` explains why that is exactly right there: for a `package.json` row to be on
 * screen the tree must already have listed every directory above it, so the walk to the root is a
 * handful of `Map` lookups and clicking a chevron never becomes a burst of filesystem calls.
 *
 * The editor has no such cache. It shows one file and knows nothing about the directories above it,
 * so the same question needs its own answer — this one lists the ancestors itself, once per
 * manifest, and holds them.
 *
 * Deliberately *not* done by lifting the tree's cache into a store: that cache is shaped by what the
 * user has expanded, so an editor reading it would give a different answer depending on whether a
 * folder happened to be open in a panel that may not even be visible. A question about the
 * filesystem should be answered by the filesystem.
 *
 * # The explicit choice always wins
 *
 * A manager the user picked is a decision, not a guess, and it short-circuits before any listing
 * happens — so choosing one also makes this free.
 */
export type ManagerSource = "explicit" | "lockfile" | "fallback";

export interface ResolvedManager {
  manager: PackageManager;
  source: ManagerSource;
  /**
   * Every manager with a lockfile at the level this was detected from.
   *
   * More than one is the case worth carrying: a repository holding both `pnpm-lock.yaml` and
   * `package-lock.json` has no single right answer, and running the first of them silently is how
   * the wrong tool ends up rewriting a lockfile. The caller asks when this has more than one entry.
   * Empty when the manager came from an explicit choice or from the fallback — neither is a
   * detection, so neither has candidates.
   */
  candidates: PackageManager[];
}

/** What `npm` means when nothing was found: the manager every Node install has. */
const FALLBACK: ResolvedManager = { manager: "npm", source: "fallback", candidates: [] };

/**
 * Lists `dir` and every directory above it, so `detectPackageManager` can walk up looking for a
 * lockfile.
 *
 * A directory that fails to list contributes nothing rather than aborting the walk — a permission
 * error three levels up must not stop a lockfile sitting right beside the manifest from being found.
 */
async function listAncestors(repoPath: string, dir: string): Promise<Map<string, FileEntry[]>> {
  const listings = new Map<string, FileEntry[]>();
  const parts = dir ? dir.split("/").filter(Boolean) : [];
  // Root first, then each level down to `dir` itself — the set the walk will ask for.
  const dirs = ["", ...parts.map((_, at) => parts.slice(0, at + 1).join("/"))];
  await Promise.all(
    dirs.map(async (each) => {
      try {
        listings.set(each, await listDir(repoPath, each || undefined));
      } catch {
        // Left absent; the walk reads a missing entry as "nothing known here" and keeps going up.
      }
    }),
  );
  return listings;
}

export function useManagerFor(repoPath: string | null, dir: string | null): ResolvedManager {
  const choice = usePackageManagerStore((s) => s.choice);
  const [detected, setDetected] = useState<ResolvedManager>(FALLBACK);

  useEffect(() => {
    // An explicit choice needs no filesystem at all, so the listing is skipped rather than done and
    // discarded.
    if (choice || !repoPath || dir === null) return;
    let alive = true;
    void listAncestors(repoPath, dir).then((listings) => {
      if (!alive) return;
      const found = detectPackageManagers(dir, listings);
      setDetected(
        found.length > 0
          ? { manager: found[0], source: "lockfile", candidates: found }
          : FALLBACK,
      );
    });
    return () => {
      alive = false;
    };
  }, [repoPath, dir, choice]);

  return choice ? { manager: choice, source: "explicit", candidates: [] } : detected;
}
