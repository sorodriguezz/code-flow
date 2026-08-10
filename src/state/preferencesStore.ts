import { create } from "zustand";
import {
  defaultLockedBranchRules,
  getLockedBranchRules,
  getSetting,
  setLockedBranchRules,
  setSetting,
} from "../lib/tauri/commands";
import { useRepoStore } from "./repoStore";

const KEY = "auto_fetch_interval_seconds";
const SECRET_SCAN_KEY = "secret_scan_enabled";
const NOTIFICATION_SOUND_KEY = "notification_sound_enabled";
export const MIN_AUTO_FETCH_SECONDS = 10;

interface PreferencesState {
  /** 0 means auto-fetch is disabled. */
  autoFetchSeconds: number;
  /** Whether the pre-commit secret scanner runs before each commit. Defaults to on. */
  secretScanEnabled: boolean;
  /**
   * Whether finished background work makes a sound. Defaults to **off**, unlike the scanner above:
   * a gate that protects you from committing a key is worth turning on for everyone, and a noise
   * an app makes on its own is worth asking for first. Nobody installs a git client hoping it will
   * start playing chords at them.
   */
  notificationSoundEnabled: boolean;
  /**
   * Branch-name patterns whose branches come locked in every repository, without anyone having
   * clicked a padlock on them — `main`, `master`, `develop` and `release/*` out of the box.
   *
   * Above workspaces and repositories on purpose: "nothing merges into main" is true of every repo
   * the user will ever open, and a per-branch switch makes them re-assert it on each one, from
   * memory, before the first mistake rather than after it. The per-branch padlock stays exactly
   * what it was — the exception to this list, in both directions.
   *
   * Kept in sync with a process-wide mirror on the Rust side, which is what the git-layer guards
   * actually read; every write goes through the backend rather than through `setSetting`, so the
   * two can't drift.
   *
   * `null` means "we don't know yet" — still loading, or the read failed. Distinct from `[]`,
   * which is a real, saved answer ("protect nothing by default"). Collapsing the two would let the
   * settings screen show an empty list the backend is not enforcing, and then let the first added
   * pattern save that empty list over rules the user still has.
   */
  lockedBranchRules: string[] | null;
  init: () => Promise<void>;
  setAutoFetchSeconds: (seconds: number) => Promise<void>;
  setSecretScanEnabled: (enabled: boolean) => Promise<void>;
  setNotificationSoundEnabled: (enabled: boolean) => Promise<void>;
  /** Saves the list and adopts the normalised version the backend stored. */
  setLockedBranchRules: (rules: string[]) => Promise<void>;
  /** Puts the shipped defaults back, asking the backend what they are so they're named once. */
  restoreLockedBranchRules: () => Promise<void>;
  /** Re-reads the list after a failed load, for the settings screen's retry. */
  reloadLockedBranchRules: () => Promise<void>;
}

function clamp(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(MIN_AUTO_FETCH_SECONDS, Math.round(seconds));
}

export const usePreferencesStore = create<PreferencesState>((set) => ({
  autoFetchSeconds: 0,
  secretScanEnabled: true,
  notificationSoundEnabled: false,
  lockedBranchRules: null,

  init: async () => {
    const [raw, scanRaw, soundRaw, rules] = await Promise.all([
      getSetting(KEY).catch(() => null),
      getSetting(SECRET_SCAN_KEY).catch(() => null),
      getSetting(NOTIFICATION_SOUND_KEY).catch(() => null),
      // Deliberately no local fallback list: the defaults are named in Rust, and inventing them
      // here would mean the screen shows rules that may not be the ones being enforced. A failure
      // stays `null` and the settings screen says so rather than drawing an empty list.
      getLockedBranchRules().catch(() => null),
    ]);
    set({
      autoFetchSeconds: raw ? clamp(Number(raw)) : 0,
      // Unset (first run) defaults to enabled — the gate is opt-out, not opt-in.
      secretScanEnabled: scanRaw === null ? true : scanRaw === "true",
      // The sound is the other way round: unset means silent, so `=== "true"` covers both an
      // absent setting and an explicit "false" without a special case for either.
      notificationSoundEnabled: soundRaw === "true",
      lockedBranchRules: rules,
    });
  },

  setAutoFetchSeconds: async (seconds) => {
    const value = clamp(seconds);
    set({ autoFetchSeconds: value });
    await setSetting(KEY, String(value));
  },

  setSecretScanEnabled: async (enabled) => {
    set({ secretScanEnabled: enabled });
    await setSetting(SECRET_SCAN_KEY, String(enabled));
  },

  setNotificationSoundEnabled: async (enabled) => {
    set({ notificationSoundEnabled: enabled });
    await setSetting(NOTIFICATION_SOUND_KEY, String(enabled));
  },

  // Not optimistic, unlike the three above: the backend normalises the list on the way in, and
  // showing the typed version first would flash a duplicate or an untrimmed entry that is about to
  // disappear. The round trip is one SQLite write.
  setLockedBranchRules: async (rules) => {
    set({ lockedBranchRules: await setLockedBranchRules(rules) });
    await refreshOpenRepoBranches();
  },

  restoreLockedBranchRules: async () => {
    set({ lockedBranchRules: await setLockedBranchRules(await defaultLockedBranchRules()) });
    await refreshOpenRepoBranches();
  },

  // Refreshes the branches too, for the same reason the two writers above do: reading also
  // re-seeds the mirror the guards consult, so this can change what is enforced — after a restored
  // backup, most of all — and the padlocks on screen have to move with it.
  reloadLockedBranchRules: async () => {
    set({ lockedBranchRules: await getLockedBranchRules() });
    await refreshOpenRepoBranches();
  },
}));

/** Re-reads the open repository's branches so the padlocks in the sidebar, the status bar and the
 * branch switcher answer to the rule that has just changed. The lock is resolved backend-side, per
 * branch, so nothing on screen moves until the branches are asked again — and editing the list
 * with a repository open is the normal case, not the edge one.
 *
 * A no-op with no repository open, and its failure is deliberately swallowed: the rule *is* saved
 * by the time this runs, and an error toast about a refresh would report the save as failed. */
async function refreshOpenRepoBranches(): Promise<void> {
  await useRepoStore.getState().refreshBranches().catch(() => {});
}
