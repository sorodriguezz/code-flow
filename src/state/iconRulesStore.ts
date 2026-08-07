import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { DEFAULT_ICON_RULES, type IconRule } from "../lib/icons/rules";

/**
 * The explorer's custom iconography, global to the app.
 *
 * Global and not per workspace, deliberately: this is a *theme*, and "`.spec.ts` looks like a test"
 * is a fact about how the user reads code, not about which client they are working for. It lives in
 * `app_settings` beside the accent and the keybindings, and travels in the backup with them.
 *
 * `null` while the first read is in flight, so the tree can tell "no rules yet" from "not read yet"
 * and avoid drawing every file with its default icon for a frame before the rules arrive.
 */
const KEY = "editor_icon_rules";
/** Its own row rather than a member of the rules blob: it is one value, it is read on every folder
 * the tree draws, and keeping it out of the array means a rules file that fails to parse does not
 * also lose it. */
const FOLDER_KEY = "editor_default_folder_icon";

interface IconRulesState {
  rules: IconRule[];
  /** Catalogue id for every folder no rule claims, or `null` for the app's own Lucide folder. */
  defaultFolderIcon: string | null;
  loaded: boolean;
  init: () => Promise<void>;
  /** Replaces the whole list — the panel edits an array and saves it whole, because every mutation
   * it offers (reorder, toggle, delete, edit) is a rewrite of the order or of one member, and a
   * per-field API would be five actions that all end in the same write. */
  save: (rules: IconRule[]) => Promise<void>;
  setDefaultFolderIcon: (icon: string | null) => Promise<void>;
  reset: () => Promise<void>;
}

/** Anything stored by an older build, or hand-edited, has to survive being wrong. A rule missing a
 * field is dropped rather than defaulted: a half-read rule that silently matched everything would
 * repaint the whole tree with one icon. */
function parseRules(raw: string): IconRule[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (entry): entry is IconRule =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as IconRule).id === "string" &&
        typeof (entry as IconRule).pattern === "string" &&
        typeof (entry as IconRule).icon === "string" &&
        ((entry as IconRule).target === "file" || (entry as IconRule).target === "folder") &&
        ["suffix", "name", "prefix", "contains", "extension"].includes(
          (entry as IconRule).match as string,
        ),
    ).map(migrateRule);
  } catch {
    return null;
  }
}

/**
 * `extension` was the fifth match kind before patterns were written as one string. It is exactly a
 * suffix of `.` plus the extension — `ts` and `*.ts` match the same set — so a stored rule is
 * rewritten rather than dropped, and nobody's icons move.
 */
function migrateRule(rule: IconRule): IconRule {
  if ((rule.match as string) !== "extension") return rule;
  return { ...rule, match: "suffix", pattern: `.${rule.pattern.replace(/^\./, "")}` };
}

export const useIconRulesStore = create<IconRulesState>((set) => ({
  rules: DEFAULT_ICON_RULES,
  defaultFolderIcon: null,
  loaded: false,

  init: async () => {
    const [raw, folder] = await Promise.all([
      getSetting(KEY).catch(() => null),
      getSetting(FOLDER_KEY).catch(() => null),
    ]);
    // Never written: the shipped set. Written and empty: the user deleted every rule, which is a
    // choice and not a reason to hand them the defaults back.
    const stored = raw === null ? null : parseRules(raw);
    set({
      rules: stored ?? DEFAULT_ICON_RULES,
      defaultFolderIcon: folder?.trim() ? folder : null,
      loaded: true,
    });
  },

  save: async (rules) => {
    set({ rules });
    await setSetting(KEY, JSON.stringify(rules)).catch(() => {});
  },

  setDefaultFolderIcon: async (icon) => {
    set({ defaultFolderIcon: icon });
    await setSetting(FOLDER_KEY, icon ?? "").catch(() => {});
  },

  reset: async () => {
    set({ rules: DEFAULT_ICON_RULES, defaultFolderIcon: null });
    await Promise.all([
      setSetting(KEY, JSON.stringify(DEFAULT_ICON_RULES)).catch(() => {}),
      setSetting(FOLDER_KEY, "").catch(() => {}),
    ]);
  },
}));
