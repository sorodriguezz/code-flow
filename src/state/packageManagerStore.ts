import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import type { PackageManager } from "../lib/packageScripts";

/**
 * Which package manager this repository's scripts are run with, when the user has said so.
 *
 * **Per repository, not global.** Somebody with a pnpm monorepo at work and a yarn side project and
 * a handful of npm scratch repos is the ordinary case, not the exotic one — a single app-wide
 * setting would be wrong for two thirds of the projects it was applied to, and wrong in the way
 * that costs a confusing error five seconds after clicking play. Stored beside the app's settings
 * under one key per repo path, exactly as `hiddenFilesStore` scopes its list.
 *
 * **Per repository, not per `package.json`.** A monorepo has one lockfile, one store and one set of
 * workspace links for the whole tree; running `packages/web` with yarn while `packages/api` uses
 * pnpm is not a configuration that works, it is two half-installed node_modules. Offering a picker
 * on every manifest would be offering a choice the tools do not actually support.
 *
 * Detection stays per directory regardless — see `detectPackageManager`, which walks up from the
 * manifest to the nearest lockfile. This store only holds the override, and `null` means "let the
 * lockfile decide", which is what almost every repository should stay on.
 */

/** One key per repo, matching how the editor is scoped. */
function key(repoPath: string): string {
  return `package_manager:${repoPath}`;
}

/** Anything that is not one of the three known managers is treated as "automatic". That covers the
 *  empty string this store writes to mean exactly that — there is no delete-a-setting command, so
 *  clearing the choice has to be storable — and it also covers a hand-edited settings row. */
function parse(stored: string | null): PackageManager | null {
  return stored === "pnpm" || stored === "yarn" || stored === "npm" ? stored : null;
}

interface PackageManagerState {
  /** The repo `choice` belongs to, so one project's override is never applied to another's tree. */
  repoPath: string | null;
  /** The user's explicit pick, or null while the lockfile decides. */
  choice: PackageManager | null;
  load: (repoPath: string) => Promise<void>;
  choose: (manager: PackageManager | null) => void;
}

export const usePackageManagerStore = create<PackageManagerState>((set, get) => ({
  repoPath: null,
  choice: null,

  load: async (repoPath) => {
    if (get().repoPath === repoPath) return;
    // Cleared before the await, not after: between here and the read below, the newly opened
    // project's tree would otherwise be pinned to the previous project's manager — a yarn repo
    // whose play buttons run pnpm for as long as one settings read takes.
    set({ repoPath, choice: null });
    const stored = await getSetting(key(repoPath)).catch(() => null);
    // A project switched again while this was in flight owns the store now.
    if (get().repoPath !== repoPath) return;
    set({ choice: parse(stored) });
  },

  choose: (manager) => {
    const { repoPath } = get();
    if (repoPath === null) return;
    set({ choice: manager });
    // `""` is how "automatic" is stored: settings rows can be written but not removed, so the
    // absence of a choice needs a value of its own rather than a missing key.
    void setSetting(key(repoPath), manager ?? "").catch(() => {});
  },
}));
