import { create } from "zustand";
import { getSetting, setSetting } from "../lib/tauri/commands";
import { DEFAULT_ICON_RULES, parseIconRules, type IconRule } from "../lib/icons/rules";
import { declareIconIds } from "../lib/icons/catalog";
import {
  BUILT_IN_PROFILES,
  DEFAULT_PROFILE_ID,
  isUntouchedLegacyRules,
  profileById,
  shippedProfile,
  type IconProfile,
} from "../lib/icons/profiles";
import { upgradeShippedProfiles } from "../lib/icons/profileUpgrade";
import { detectRepoProfile } from "../lib/icons/detectProfile";
import { watchSettings } from "../lib/settingsSync";

/**
 * The explorer's custom iconography: named profiles, one of them active per repository.
 *
 * **The profiles are global; only the selection is not.** See `lib/icons/profiles.ts` for why. In
 * practice that means two settings rows of different kinds: one blob holding every profile, beside
 * the accent and the keybindings and travelling in the backup with them, and one tiny key per
 * repository holding an id.
 *
 * `rules` and `defaultFolderIcon` are the *active* profile's, kept as real state rather than derived
 * on read. Every file row in every tree asks for them on every repaint; a selector that indexed into
 * a list of profiles on each call would be doing that lookup a few hundred times a frame, and the
 * two consumers that existed before profiles did keep working untouched.
 *
 * `loaded` is false until the first read lands, so the tree can tell "no rules" from "not read yet"
 * and avoid drawing every file with its default icon for a frame before the rules arrive.
 */
const KEY = "editor_icon_profiles";
/** Every shipped profile id this install has been given. Nothing here decides by it any more; it is
 * kept current for v2.0.1–2.0.3, which read it. See `lib/icons/profileUpgrade.ts`. */
const OFFERED_KEY = "editor_icon_profiles_offered";
/** The shipped packs the user deleted, written by `removeProfile` before the list without them. The
 * only thing that keeps a deleted pack deleted: absence alone is also what an older build writing
 * over the list looks like. See `lib/icons/profileUpgrade.ts`. */
const REMOVED_KEY = "editor_icon_profiles_removed";
/** Where the rules lived before profiles existed. Read once, at migration, and never written again. */
const LEGACY_RULES_KEY = "editor_icon_rules";
const LEGACY_FOLDER_KEY = "editor_default_folder_icon";

/** One row per repository, keyed on its path — the same shape `editor_hidden:` uses, and the same
 * scope the editor's tree itself is opened at. */
const SELECTION_PREFIX = "editor_icon_profile:";

function selectionKey(repoPath: string): string {
  return `${SELECTION_PREFIX}${repoPath}`;
}

/**
 * The selector's own entry for "this repository has no choice of its own": use the pack its stack
 * calls for. Stored as an empty selection, which is also what a repository that never chose has.
 */
export const AUTO_PROFILE = "__auto__";

/**
 * What each repository's root says it is, asked once per repository per session: it is a directory
 * listing and a manifest or two, and a checkout does not change stack while it is open.
 */
const detections = new Map<string, Promise<string | null>>();

function detectedFor(repoPath: string): Promise<string | null> {
  let pending = detections.get(repoPath);
  if (!pending) {
    pending = detectRepoProfile(repoPath);
    detections.set(repoPath, pending);
  }
  return pending;
}

/** A repository's own choice, and what detection says about it — both, because the selector names
 * the detected pack even while an explicit choice is in force. */
async function readSelection(repoPath: string): Promise<{ chosen: string | null; detected: string | null }> {
  const [raw, detected] = await Promise.all([
    getSetting(selectionKey(repoPath)).catch(() => null),
    detectedFor(repoPath),
  ]);
  return { chosen: raw?.trim() || null, detected };
}

/** A stored list of profile ids — `offered` or `removed`. `null` when there is none, or none readable. */
function parseIds(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

interface IconRulesState {
  profiles: IconProfile[];
  /** The repository `activeId` was read for. `null` before one is open — the app draws trees during
   * startup, and they should use the default profile rather than the previous repository's. */
  repoPath: string | null;
  activeId: string;
  /** The active profile's rules, flattened out for the hot path. */
  rules: IconRule[];
  defaultFolderIcon: string | null;
  loaded: boolean;
  /** Whether the open repository has no choice of its own, so `activeId` is the pack its stack called
   * for (or the default). Always false with no repository open. */
  autoSelected: boolean;
  /** The pack the open repository's root was recognised as, `null` when it was not. */
  detectedId: string | null;

  init: () => Promise<void>;
  /** Points the store at a repository and reads that repository's choice. */
  setRepo: (repoPath: string | null) => Promise<void>;
  /** Re-reads the current repository's choice after another window changed it. */
  refreshSelection: () => Promise<void>;
  /** Switches the *current repository* to another profile — or, given `AUTO_PROFILE`, back to the
   * one its stack calls for. Writes nothing when none is open — there would be nowhere to write it,
   * and a selection that silently applied everywhere is the behaviour profiles exist to end. */
  selectProfile: (id: string) => Promise<void>;

  /** Replaces the active profile's rule list. The panel edits an array and saves it whole, because
   * every mutation it offers (reorder, toggle, delete, edit) is a rewrite of the order or of one
   * member, and a per-field API would be five actions that all end in the same write. */
  save: (rules: IconRule[]) => Promise<void>;
  setDefaultFolderIcon: (icon: string | null) => Promise<void>;

  addProfile: (name: string) => Promise<void>;
  /** A copy of `id`, which is how you start from Angular and change four rules. */
  duplicateProfile: (id: string, name: string) => Promise<void>;
  /** A profile that arrived as a file: it is ADDED, never merged into the active one. The reading
   * and validating is `lib/icons/profileFile.ts`; this is only the write. */
  importProfile: (incoming: {
    name: string;
    rules: IconRule[];
    defaultFolderIcon: string | null;
  }) => Promise<void>;
  renameProfile: (id: string, name: string) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  /**
   * Puts the *active* profile back to the rules this app ships for it, keeping the name the user
   * gave it and leaving every other profile alone.
   *
   * Per profile rather than per app because that is the scale at which the question is asked: you
   * have been editing Angular's list, it is worse than it was, and you want that list back — not
   * every profile you own replaced. A profile with no shipped counterpart has nothing to restore
   * and this does nothing; see `shippedProfile`.
   */
  resetProfile: () => Promise<void>;
  /** Restores the shipped profiles, discarding every edit and every profile the user added. */
  resetAll: () => Promise<void>;
}

/** Whether two rule lists say the same thing, rule for rule — ids aside, which only key the panel. */
function sameRuleList(a: IconRule[], b: IconRule[]): boolean {
  if (a === b) return true;
  return (
    a.length === b.length &&
    a.every((rule, index) => {
      const other = b[index];
      return (
        rule.target === other.target &&
        rule.match === other.match &&
        rule.pattern === other.pattern &&
        rule.icon === other.icon &&
        rule.enabled === other.enabled
      );
    })
  );
}

/**
 * How a profile is written to settings. A shipped pack nobody has edited is stored as a reference —
 * its id, its name, `shipped: true` — and its rules are read back from the code.
 *
 * The packs are six hundred-odd rules each and there are eleven of them: written out whole, the row
 * was close to a megabyte, rewritten on every edit and re-parsed by every window on every change.
 * As references it is a few hundred bytes until the user actually edits a pack, and an untouched
 * pack follows whatever the next version ships without a migration.
 */
function storedForm(profile: IconProfile): unknown {
  const shipped = shippedProfile(profile.id);
  if (
    shipped &&
    profile.defaultFolderIcon === shipped.defaultFolderIcon &&
    sameRuleList(profile.rules, shipped.rules)
  ) {
    return { id: profile.id, name: profile.name, defaultFolderIcon: profile.defaultFolderIcon, shipped: true };
  }
  return profile;
}

/** The same tolerance one level up. A profile without a usable rule list is dropped whole rather
 * than kept as an empty one the user would have to work out how to fix. */
function parseProfiles(raw: string): IconProfile[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const profiles: IconProfile[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as Partial<IconProfile> & { shipped?: unknown };
      // A reference to a shipped pack takes that pack's rules — the array itself, which nothing ever
      // mutates: every edit builds a new one. A reference to a pack this version no longer ships has
      // nothing to point at and is dropped like any other unreadable entry.
      const rules =
        candidate.shipped === true && typeof candidate.id === "string"
          ? (shippedProfile(candidate.id)?.rules ?? null)
          : parseIconRules(candidate.rules);
      if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || !rules) continue;
      profiles.push({
        id: candidate.id,
        name: candidate.name,
        rules,
        defaultFolderIcon:
          typeof candidate.defaultFolderIcon === "string" && candidate.defaultFolderIcon.trim()
            ? candidate.defaultFolderIcon
            : null,
      });
    }
    return profiles;
  } catch {
    return null;
  }
}

/**
 * The profile list for an install that predates profiles.
 *
 * The shipped set, plus — if the old global list was actually edited — one more profile holding it,
 * selected by default. Somebody who spent an afternoon on their rules must not open this version and
 * find them replaced by Angular's, and somebody who never touched the panel must not be given a
 * pointless copy of the defaults to choose between.
 */
function migrateLegacy(rules: IconRule[] | null, folderIcon: string | null): {
  profiles: IconProfile[];
  activeId: string;
} {
  if (!rules || (isUntouchedLegacyRules(rules) && !folderIcon)) {
    return { profiles: BUILT_IN_PROFILES, activeId: DEFAULT_PROFILE_ID };
  }
  const mine: IconProfile = {
    id: "custom",
    // Not translated: a profile name is data the user can rename, and one that changed language
    // under them would look like a different profile.
    name: "Custom",
    rules,
    defaultFolderIcon: folderIcon,
  };
  return { profiles: [mine, ...BUILT_IN_PROFILES], activeId: mine.id };
}

/** Ids only have to be unique within the list, and the list is small — a counter off the clock is
 * enough, and it keeps the profiles file readable when someone opens it. */
function newProfileId(): string {
  return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export const useIconRulesStore = create<IconRulesState>((set, get) => {
  /**
   * The one place the active profile is flattened into `rules`/`defaultFolderIcon`, so the two can
   * never disagree with `profiles` and `activeId`.
   *
   * `activeId` is kept **verbatim**, even when no profile answers to it. The two things that set it
   * — reading the profiles blob and reading this repository's choice — are independent async reads
   * that land in either order, and a repository pointing at a profile the user wrote will arrive
   * before the profiles do about half the time. Resolving the id here would turn that ordering into
   * "your choice was silently replaced by Angular"; leaving it alone means the id survives the wait
   * and `init` resolves it once there is something real to resolve against. Meanwhile the *rules*
   * still fall back, so the tree draws something sensible rather than nothing.
   */
  const applied = (profiles: IconProfile[], activeId: string) => {
    const active = profileById(profiles, activeId);
    // Every id in *every* profile, not just the active one. The catalogue keeps only the glyphs
    // something can ask for (see `lib/icons/catalog.ts`), and switching profiles — or switching
    // repository, which switches profile — must not be the moment an icon discovers it was pruned.
    // Cheap enough to do on each call: it is a set membership test per id, and it re-reads a set
    // only when an id is genuinely absent.
    declareIconIds(
      profiles.flatMap((profile) => [profile.defaultFolderIcon, ...profile.rules.map((r) => r.icon)]),
    );
    return {
      profiles,
      activeId,
      rules: active?.rules ?? DEFAULT_ICON_RULES,
      defaultFolderIcon: active?.defaultFolderIcon ?? null,
    };
  };

  /** An id that names a profile that exists, for the moments where that is knowable — after the
   * profiles are loaded, and never before. */
  const resolve = (profiles: IconProfile[], wanted: string): string =>
    profiles.some((profile) => profile.id === wanted)
      ? wanted
      : (profileById(profiles, DEFAULT_PROFILE_ID)?.id ?? wanted);

  const persist = async (profiles: IconProfile[]) => {
    await setSetting(KEY, JSON.stringify(profiles.map(storedForm))).catch(() => {});
  };

  /** Writes down that the user deleted a shipped pack. Read from the row rather than kept in memory,
   * because every window runs this store and only the row is shared. */
  const recordRemoved = async (id: string) => {
    const removed = parseIds(await getSetting(REMOVED_KEY).catch(() => null)) ?? [];
    if (removed.includes(id)) return;
    await setSetting(REMOVED_KEY, JSON.stringify([...removed, id])).catch(() => {});
  };

  /** Rewrites the active profile in place. Every rule edit is one of these. */
  const patchActive = async (patch: (profile: IconProfile) => IconProfile) => {
    const { profiles, activeId } = get();
    const next = profiles.map((profile) => (profile.id === activeId ? patch(profile) : profile));
    set(applied(next, activeId));
    await persist(next);
  };

  return {
    profiles: BUILT_IN_PROFILES,
    repoPath: null,
    activeId: DEFAULT_PROFILE_ID,
    rules: profileById(BUILT_IN_PROFILES, DEFAULT_PROFILE_ID)?.rules ?? DEFAULT_ICON_RULES,
    defaultFolderIcon: null,
    loaded: false,
    autoSelected: false,
    detectedId: null,

    init: async () => {
      const [raw, offeredRaw, removedRaw] = await Promise.all([
        // `undefined`, not `null`, when the read itself fails: that says nothing about what is stored,
        // and "no row" is the one answer that lets the migration below write over it.
        getSetting(KEY).catch(() => undefined),
        getSetting(OFFERED_KEY).catch(() => null),
        getSetting(REMOVED_KEY).catch(() => null),
      ]);
      const stored = typeof raw === "string" ? parseProfiles(raw) : null;
      if (stored && stored.length > 0) {
        // The packs this version ships, brought into a list that was written by an older one — new
        // ones added, untouched old ones replaced, anything the user edited or deleted left as it is.
        // Idempotent, which matters: this runs again every time the row below is rewritten.
        const upgrade = upgradeShippedProfiles(stored, parseIds(offeredRaw), parseIds(removedRaw));
        const profiles = upgrade.profiles;
        // `get().activeId` rather than the default: a `setWorkspace` that landed first already put
        // this repository's choice there, and this is the point where it can finally be checked
        // against a real list.
        set({ ...applied(profiles, resolve(profiles, get().activeId)), loaded: true });
        // The records first, so the re-read the profiles write triggers already knows them.
        if (upgrade.removedChanged) {
          await setSetting(REMOVED_KEY, JSON.stringify(upgrade.removed)).catch(() => {});
        }
        if (upgrade.offeredChanged) {
          await setSetting(OFFERED_KEY, JSON.stringify(upgrade.offered)).catch(() => {});
        }
        if (upgrade.changed) await persist(profiles);
        return;
      }

      if (raw !== null) {
        // A row this version cannot read — written by a newer build, or damaged — or a read that
        // failed. Keep drawing what is in memory and write nothing. Running the migration below over
        // it is exactly how v2.0.0, opened after a newer build, replaced eleven packs with its own
        // three (2026-09-24). A user edit may still write over it; that at least is a choice.
        set({ ...applied(get().profiles, resolve(get().profiles, get().activeId)), loaded: true });
        return;
      }

      // No profiles row: either a fresh install or one upgrading from the single global list.
      const [legacyRaw, legacyFolder] = await Promise.all([
        getSetting(LEGACY_RULES_KEY).catch(() => null),
        getSetting(LEGACY_FOLDER_KEY).catch(() => null),
      ]);
      let legacy: IconRule[] | null = null;
      if (legacyRaw !== null) {
        try {
          legacy = parseIconRules(JSON.parse(legacyRaw) as unknown);
        } catch {
          legacy = null;
        }
      }
      const { profiles, activeId } = migrateLegacy(
        legacy,
        legacyFolder?.trim() ? legacyFolder : null,
      );
      // Written now rather than on the first edit, so the migration happens once and the next launch
      // reads the profiles row instead of re-deriving it from keys that may since have been cleared.
      set({ ...applied(profiles, activeId), loaded: true });
      await setSetting(REMOVED_KEY, "[]").catch(() => {});
      await setSetting(OFFERED_KEY, JSON.stringify(BUILT_IN_PROFILES.map((profile) => profile.id))).catch(
        () => {},
      );
      await persist(profiles);
    },

    setRepo: async (repoPath) => {
      if (get().repoPath === repoPath) return;
      if (repoPath === null) {
        set({ repoPath: null, autoSelected: false, detectedId: null, ...applied(get().profiles, DEFAULT_PROFILE_ID) });
        return;
      }
      // Claimed before the reads: a second switch that lands while these are out must not be
      // overwritten by this one's answer, and the check after the await is what enforces it.
      set({ repoPath });
      const { chosen, detected } = await readSelection(repoPath);
      if (get().repoPath !== repoPath) return;
      // A repository that has never chosen gets the pack its stack calls for, then the default — never
      // whatever the last one was using: the Angular app and the Nest API are two checkouts, and
      // opening the second must not inherit the first's answer to what `*.service.ts` is.
      const wanted = chosen ?? detected ?? DEFAULT_PROFILE_ID;
      const { profiles, loaded } = get();
      set({
        autoSelected: chosen === null,
        detectedId: detected,
        // Only checked against the list once there *is* a list — before that the id is carried as
        // written and `init` does the checking. See `applied`.
        ...applied(profiles, loaded ? resolve(profiles, wanted) : wanted),
      });
    },

    refreshSelection: async () => {
      const { repoPath } = get();
      if (!repoPath) return;
      const { chosen, detected } = await readSelection(repoPath);
      // The repository may have changed while the read was out; its own `setRepo` has the answer.
      if (get().repoPath !== repoPath) return;
      const { profiles, loaded } = get();
      const wanted = chosen ?? detected ?? DEFAULT_PROFILE_ID;
      set({
        autoSelected: chosen === null,
        detectedId: detected,
        ...applied(profiles, loaded ? resolve(profiles, wanted) : wanted),
      });
    },

    selectProfile: async (id) => {
      const { profiles, repoPath, detectedId } = get();
      if (id === AUTO_PROFILE) {
        // Back to what the stack says: the repository's own choice is cleared rather than set to the
        // detected pack, so it keeps following detection if the stack — or the packs — change.
        set({
          autoSelected: repoPath !== null,
          ...applied(profiles, resolve(profiles, detectedId ?? DEFAULT_PROFILE_ID)),
        });
        if (repoPath) await setSetting(selectionKey(repoPath), "").catch(() => {});
        return;
      }
      set({ autoSelected: false, ...applied(profiles, id) });
      if (repoPath) await setSetting(selectionKey(repoPath), id).catch(() => {});
    },

    save: async (rules) => {
      await patchActive((profile) => ({ ...profile, rules }));
    },

    setDefaultFolderIcon: async (icon) => {
      await patchActive((profile) => ({ ...profile, defaultFolderIcon: icon }));
    },

    addProfile: async (name) => {
      // Starts empty rather than from the defaults: "new profile" is reached by someone whose stack
      // is none of the three shipped ones, and handing them Angular's rules to delete is work.
      // Starting *from* a profile is what `duplicateProfile` is for.
      const profile: IconProfile = {
        id: newProfileId(),
        name: name.trim() || "Profile",
        rules: [],
        defaultFolderIcon: null,
      };
      const next = [...get().profiles, profile];
      set({ autoSelected: false, ...applied(next, profile.id) });
      await persist(next);
      const { repoPath } = get();
      if (repoPath) await setSetting(selectionKey(repoPath), profile.id).catch(() => {});
    },

    duplicateProfile: async (id, name) => {
      const source = get().profiles.find((profile) => profile.id === id);
      if (!source) return;
      const copy: IconProfile = {
        ...source,
        id: newProfileId(),
        name: name.trim() || `${source.name} copy`,
        // Rule ids are cloned with the rules on purpose: they only have to be unique *within* a
        // profile, and keeping them makes two profiles diffable when someone opens the settings row.
        rules: source.rules.map((rule) => ({ ...rule })),
      };
      const next = [...get().profiles, copy];
      set({ autoSelected: false, ...applied(next, copy.id) });
      await persist(next);
      const { repoPath } = get();
      if (repoPath) await setSetting(selectionKey(repoPath), copy.id).catch(() => {});
    },

    /**
     * A profile read out of a file, added to the list and selected here.
     *
     * **The file's own id is ignored and a fresh one minted.** A file claiming `id: "angular"` would
     * make `shippedProfile` answer for it, so the panel would offer to restore the factory rules
     * over somebody else's list and then do it; and two profiles sharing an id make `profileById`
     * answer with the first, leaving the second unreachable from the selector that just created it.
     *
     * **It is added, not merged.** Folding an imported list into the active one has no correct
     * answer — the list is first-match-wins, so "before or after the rules already there" changes
     * which icons the tree draws and neither choice is the one the user meant. And it would not be
     * undoable: `persist` rewrites the only copy there is. Adding a profile is undone by deleting
     * it, which is a menu entry away.
     *
     * **`loaded` gates the write.** Until `init` lands, `profiles` is still `BUILT_IN_PROFILES`;
     * persisting from there would write the three shipped profiles plus this one over a settings row
     * that has the user's own, and the read still in flight would arrive to a blob already replaced.
     * The panel disables the menu entry for the same reason — this is the belt to that pair of
     * braces, because the store is where the write actually happens.
     */
    importProfile: async (incoming) => {
      if (!get().loaded) return;
      const profile: IconProfile = {
        id: newProfileId(),
        name: incoming.name.trim() || "Profile",
        rules: incoming.rules.map((rule) => ({ ...rule })),
        defaultFolderIcon: incoming.defaultFolderIcon,
      };
      const next = [...get().profiles, profile];
      set({ autoSelected: false, ...applied(next, profile.id) });
      await persist(next);
      const { repoPath } = get();
      if (repoPath) await setSetting(selectionKey(repoPath), profile.id).catch(() => {});
    },

    renameProfile: async (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const next = get().profiles.map((profile) =>
        profile.id === id ? { ...profile, name: trimmed } : profile,
      );
      set(applied(next, get().activeId));
      await persist(next);
    },

    removeProfile: async (id) => {
      const { profiles, activeId, repoPath, autoSelected, detectedId } = get();
      // The last one is not removable: with no profiles there is no rule list to fall back to, and
      // an explorer whose icons vanished with no way back is not a state worth being able to reach.
      if (profiles.length <= 1) return;
      const next = profiles.filter((profile) => profile.id !== id);
      // Before the list that no longer has it: the re-read that write triggers in every window must
      // already find the pack recorded as deleted, or `init` would put it straight back.
      if (shippedProfile(id)) await recordRemoved(id);
      // A repository following detection keeps following it: nothing is written for it, and the pack
      // its stack calls for is re-resolved against the shorter list (to the default if that was the
      // one removed).
      if (autoSelected) {
        set(applied(next, resolve(next, detectedId ?? DEFAULT_PROFILE_ID)));
        await persist(next);
        return;
      }
      // Resolved explicitly, because `applied` deliberately does not: deleting the profile a
      // repository was on is the one case where the id genuinely has to move, and the repo's
      // stored choice has to move with it or the next launch reads a profile that is gone.
      const nextActive = next.some((profile) => profile.id === activeId)
        ? activeId
        : (next[0]?.id ?? activeId);
      set(applied(next, nextActive));
      await persist(next);
      if (repoPath && nextActive !== activeId) {
        await setSetting(selectionKey(repoPath), nextActive).catch(() => {});
      }
    },

    resetProfile: async () => {
      const { profiles, activeId } = get();
      const shipped = shippedProfile(activeId);
      if (!shipped) return;
      const next = profiles.map((profile) =>
        profile.id === activeId
          ? {
              ...profile,
              // The name is the user's — restoring the rules of a profile they renamed to "Front"
              // must not rename it back to Angular. Rules are copied so the shipped constant is
              // never handed out as something the panel can then mutate in place.
              rules: shipped.rules.map((rule) => ({ ...rule })),
              defaultFolderIcon: shipped.defaultFolderIcon,
            }
          : profile,
      );
      set(applied(next, activeId));
      await persist(next);
    },

    resetAll: async () => {
      // Factory state includes "follow the stack": the open repository's own choice is cleared, not
      // pinned to a pack, so it goes back to whatever detection says it is.
      const { repoPath, detectedId } = get();
      const wanted = repoPath ? (detectedId ?? DEFAULT_PROFILE_ID) : DEFAULT_PROFILE_ID;
      set({ autoSelected: repoPath !== null, ...applied(BUILT_IN_PROFILES, resolve(BUILT_IN_PROFILES, wanted)) });
      await setSetting(REMOVED_KEY, "[]").catch(() => {});
      await setSetting(OFFERED_KEY, JSON.stringify(BUILT_IN_PROFILES.map((profile) => profile.id))).catch(
        () => {},
      );
      await persist(BUILT_IN_PROFILES);
      if (repoPath) await setSetting(selectionKey(repoPath), "").catch(() => {});
    },
  };
});

// The profiles are edited in Settings › Editor (main window only) and drawn by every explorer, a
// repository window's included. `init` re-reads the list and re-checks the active id against it.
watchSettings([KEY], () => useIconRulesStore.getState().init());
// The per-repository choice, which the same screen writes for the repository open in *its* window —
// the one a repository window may be holding. See `lib/settingsSync`.
watchSettings(
  (key) => key.startsWith(SELECTION_PREFIX),
  () => useIconRulesStore.getState().refreshSelection(),
);
