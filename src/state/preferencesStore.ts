import { create } from "zustand";
import {
  defaultLockedBranchRules,
  getLockedBranchRules,
  getSettings,
  setLockedBranchRules,
  setSetting,
} from "../lib/tauri/commands";
import { useRepoStore } from "./repoStore";
import { DEFAULT_SATELLITE_LIMIT, useWindowStore } from "./windowStore";

const NATIVE_NOTIFICATIONS_KEY = "native_notifications_enabled";
const NATIVE_ONLY_BACKGROUND_KEY = "native_notifications_only_background";
const MUTED_SOURCES_KEY = "muted_notification_sources";
const PIPELINE_POLL_KEY = "pipeline_poll_seconds";
const KEY = "auto_fetch_interval_seconds";
const SECRET_SCAN_KEY = "secret_scan_enabled";
const NOTIFICATION_SOUND_KEY = "notification_sound_enabled";
const BLAME_ANNOTATION_KEY = "blame_annotation_enabled";
const WINDOW_LIMIT_KEY = "satellite_window_limit";
export const MIN_AUTO_FETCH_SECONDS = 10;

/**
 * How many satellite windows are allowed, from a stored string.
 *
 * Zero is a real answer — "never open a second window" — so the clamp starts there rather than at
 * one. The upper bound matches `MAX_SATELLITES` in `windows.rs`: a setting the backend would refuse
 * to honour is a setting that lies.
 */
function clampWindows(raw: string | undefined | null): number {
  if (raw == null) return DEFAULT_SATELLITE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SATELLITE_LIMIT;
  return Math.max(0, Math.min(8, Math.round(parsed)));
}

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
   * Whether finished work also raises an operating-system notification.
   *
   * Defaults to **off** for the same reason the sound does, plus one of its own: turning it on is
   * what asks the OS for permission, and a permission prompt on first launch — before the user has
   * seen anything finish — is one people dismiss on reflex and can then only undo in System
   * Settings. So the prompt happens the moment somebody asks for the feature.
   */
  nativeNotificationsEnabled: boolean;
  /**
   * Whether a system notification is suppressed while the window is in front.
   *
   * On by default, because that is the whole point of the feature: a banner telling you about
   * something you are already looking at is noise. Off, every completion notifies — which some
   * people genuinely want on a second monitor.
   */
  nativeNotificationsOnlyBackground: boolean;
  /**
   * Sources whose completions are not recorded at all, by `NotificationSource` id.
   *
   * Suppressed rather than hidden: a muted source never reaches the bell, so the unread count
   * matches what the list will show. Stored as a comma-separated string because that is what a
   * settings row holds, and the set is a dozen short ids.
   */
  mutedNotificationSources: string[];
  /**
   * How often a live pipeline run is re-read, in seconds.
   *
   * The Pipelines tab is this app's only polling client, and the cost lands on somebody else's rate
   * limit — see `PIPELINE_POLL_CHOICES`. Five seconds is the default and the fastest offered.
   */
  pipelinePollSeconds: number;
  /**
   * Whether the editor annotates the caret's line with who last changed it. Defaults to **off**, for
   * the same kind of reason the sound above does but a stronger one: nothing is at risk if this is
   * absent, and turning it on puts a git revwalk behind the caret in every file you open. An editor
   * that quietly starts doing extra work per keystroke is a thing to opt into, not out of — and "off"
   * here means no blame call at all, not a hidden annotation, so the cost of leaving it alone is one
   * boolean read per caret move.
   *
   * (VS Code ships GitLens' line blame on. VS Code also never had to answer for a 200 ms libgit2
   * revwalk on a large-history repository, which is the number we do not yet have a bound on.)
   */
  blameAnnotationEnabled: boolean;
  /**
   * How many apps and repositories may be open in windows of their own, besides the main one.
   *
   * A setting rather than a constant because the right answer is about the machine, not about the
   * app: four covers the case this was asked for — API client, database, frontend, backend — on a
   * laptop, and someone on a desktop with 64 GB has no reason to be held to it. Enforced where the
   * button is (`windowStore.detach`) so the refusal can name the limit; `windows.rs` keeps a hard
   * ceiling underneath it that no setting can raise.
   */
  satelliteLimit: number;
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
  setNativeNotificationsEnabled: (enabled: boolean) => Promise<void>;
  setNativeNotificationsOnlyBackground: (enabled: boolean) => Promise<void>;
  setNotificationSourceMuted: (source: string, muted: boolean) => Promise<void>;
  setPipelinePollSeconds: (seconds: number) => Promise<void>;
  setBlameAnnotationEnabled: (enabled: boolean) => Promise<void>;
  setSatelliteLimit: (limit: number) => Promise<void>;
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

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  autoFetchSeconds: 0,
  secretScanEnabled: true,
  notificationSoundEnabled: false,
  nativeNotificationsEnabled: false,
  nativeNotificationsOnlyBackground: true,
  mutedNotificationSources: [],
  pipelinePollSeconds: 5,
  blameAnnotationEnabled: false,
  satelliteLimit: DEFAULT_SATELLITE_LIMIT,
  lockedBranchRules: null,

  init: async () => {
    // The plain settings go in one `getSettings`: separate `getSetting` calls inside a
    // `Promise.all` looked concurrent but weren't, since each one takes the database mutex on the
    // Rust side — which is also why a new flag joins this array rather than adding a call. The rules
    // stay a separate command — it is not a settings row, it re-seeds the cache the git guards read —
    // so it keeps its own slot in the `Promise.all`, where it really does overlap with the batch.
    const [stored, rules] = await Promise.all([
      getSettings([
        KEY,
        SECRET_SCAN_KEY,
        NOTIFICATION_SOUND_KEY,
        NATIVE_NOTIFICATIONS_KEY,
        NATIVE_ONLY_BACKGROUND_KEY,
        MUTED_SOURCES_KEY,
        PIPELINE_POLL_KEY,
        BLAME_ANNOTATION_KEY,
        WINDOW_LIMIT_KEY,
      ]).catch(
        () => ({}) as Record<string, string>,
      ),
      // Deliberately no local fallback list: the defaults are named in Rust, and inventing them
      // here would mean the screen shows rules that may not be the ones being enforced. A failure
      // stays `null` and the settings screen says so rather than drawing an empty list.
      getLockedBranchRules().catch(() => null),
    ]);
    // `?? null` reproduces `getSetting`'s answer for an unset key, which `getSettings` reports by
    // omission — load-bearing just below, where `null` and `"false"` take different branches.
    const raw = stored[KEY] ?? null;
    const scanRaw = stored[SECRET_SCAN_KEY] ?? null;
    const soundRaw = stored[NOTIFICATION_SOUND_KEY] ?? null;
    set({
      autoFetchSeconds: raw ? clamp(Number(raw)) : 0,
      // Unset (first run) defaults to enabled — the gate is opt-out, not opt-in.
      secretScanEnabled: scanRaw === null ? true : scanRaw === "true",
      // The sound is the other way round: unset means silent, so `=== "true"` covers both an
      // absent setting and an explicit "false" without a special case for either.
      notificationSoundEnabled: soundRaw === "true",
      // Same shape: unset and explicit-false both mean "don't".
      nativeNotificationsEnabled: stored[NATIVE_NOTIFICATIONS_KEY] === "true",
      // The one boolean here that defaults to *on*, so unset has to be its own branch.
      nativeNotificationsOnlyBackground: (stored[NATIVE_ONLY_BACKGROUND_KEY] ?? null) === null
        ? true
        : stored[NATIVE_ONLY_BACKGROUND_KEY] === "true",
      pipelinePollSeconds: Number(stored[PIPELINE_POLL_KEY]) || 5,
      mutedNotificationSources: (stored[MUTED_SOURCES_KEY] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
      // Same one-liner, same reason: unset and explicit-false are both "don't blame anything".
      blameAnnotationEnabled: stored[BLAME_ANNOTATION_KEY] === "true",
      satelliteLimit: clampWindows(stored[WINDOW_LIMIT_KEY]),
      lockedBranchRules: rules,
    });
    // The store that enforces it keeps its own copy, so the rail can refuse without reaching across
    // stores on every press. One writer, mirrored — not two sources.
    useWindowStore.getState().setLimit(get().satelliteLimit);
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

  setNativeNotificationsEnabled: async (enabled) => {
    set({ nativeNotificationsEnabled: enabled });
    await setSetting(NATIVE_NOTIFICATIONS_KEY, String(enabled));
  },

  setNativeNotificationsOnlyBackground: async (enabled) => {
    set({ nativeNotificationsOnlyBackground: enabled });
    await setSetting(NATIVE_ONLY_BACKGROUND_KEY, String(enabled));
  },

  setPipelinePollSeconds: async (seconds) => {
    set({ pipelinePollSeconds: seconds });
    await setSetting(PIPELINE_POLL_KEY, String(seconds));
  },

  setNotificationSourceMuted: async (source, muted) => {
    const next = muted
      ? Array.from(new Set([...get().mutedNotificationSources, source]))
      : get().mutedNotificationSources.filter((entry) => entry !== source);
    set({ mutedNotificationSources: next });
    await setSetting(MUTED_SOURCES_KEY, next.join(","));
  },

  // Optimistic like the three above, and for the reason spelled out below `setLockedBranchRules`:
  // there is nothing for the backend to normalise about a boolean, so the value that comes back can
  // only ever be the one that went in — waiting for the write would put a SQLite round trip between
  // the click and the checkbox moving.
  setBlameAnnotationEnabled: async (enabled) => {
    set({ blameAnnotationEnabled: enabled });
    await setSetting(BLAME_ANNOTATION_KEY, String(enabled));
  },

  setSatelliteLimit: async (limit) => {
    const value = clampWindows(String(limit));
    set({ satelliteLimit: value });
    useWindowStore.getState().setLimit(value);
    await setSetting(WINDOW_LIMIT_KEY, String(value));
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
