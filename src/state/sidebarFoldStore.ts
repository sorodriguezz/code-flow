import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { watchSettings } from "../lib/settingsSync";

const KEY = "sidebar_folded_sections";

/**
 * Which of a repository's sections in the projects panel the user folded — local and remote
 * branches, the remote URL, tags, submodules, stashes, worktrees, pull requests.
 *
 * The folded ones, not the open ones: the sections open by default (user request, 2026-10-10 — a
 * repository that arrives as a column of closed chevrons is a list of titles to click through before
 * anything is on screen), so the exceptions are what is worth writing down. One list for every
 * repository rather than one per repo: the sections are the same in each, and what gets folded is
 * about the section — a tag list nobody reads — not about one repository.
 *
 * In `app_settings` like every other fold that outlives the window (see `servicesStore`), so it
 * travels with a backup.
 */
interface SidebarFoldState {
  /**
   * `null` until read, and every section reads as folded until then rather than open: an open
   * default would show sections the user had folded for a frame — and unfold pull requests long
   * enough to fetch them (see `PullRequestsSection.activated`).
   */
  folded: string[] | null;
  load: () => Promise<void>;
  setOpen: (section: string, open: boolean) => void;
}

export const useSidebarFoldStore = create<SidebarFoldState>((set, get) => ({
  folded: null,

  load: async () => {
    let folded: string[] = [];
    try {
      const parsed: unknown = JSON.parse((await getSetting(KEY)) ?? "[]");
      if (Array.isArray(parsed)) folded = parsed.filter((k): k is string => typeof k === "string");
    } catch {
      // Unreadable, or outside Tauri: everything open, which is the default anyway.
    }
    set({ folded });
  },

  setOpen: (section, open) => {
    const current = get().folded;
    // Not read yet: writing now would replace the stored list with this one change.
    if (current === null || current.includes(section) !== open) return;
    const folded = open ? current.filter((k) => k !== section) : [...current, section];
    set({ folded });
    void setSetting(KEY, JSON.stringify(folded)).catch(() => {});
  },
}));

/** A section's fold, as `CollapsibleSection`'s controlled pair: spread it onto the section. */
export function useSectionFold(section: string): { open: boolean; onOpenChange: (open: boolean) => void } {
  const open = useSidebarFoldStore((s) => s.folded !== null && !s.folded.includes(section));
  const setOpen = useSidebarFoldStore((s) => s.setOpen);
  return { open, onOpenChange: (next) => setOpen(section, next) };
}

// Read at startup rather than on the first section's mount, so a repository's sections are already
// decided when its tree lands instead of opening a round trip later.
void useSidebarFoldStore.getState().load();
watchSettings([KEY], () => useSidebarFoldStore.getState().load());
