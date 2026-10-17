import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useShortcutsStore, activeChords, bindingFor } from "../../state/shortcutsStore";
import { useQuickAskHotkeyStore } from "../../state/quickAskHotkeyStore";
import {
  DEFAULT_LOCK_CHORD,
  LOCK_ARROWS,
  lockChordKeycaps,
  sameLockChord,
  usableLockChord,
  useSwitcherLockStore,
  type LockAxis,
} from "../../state/switcherLockStore";
import { SHORTCUT_COMMANDS, type ShortcutId } from "../../lib/shortcuts";
import { chordKeycaps, eventToChord, isBindable } from "../../lib/keys";
import { acceleratorFromKey, acceleratorKeycaps } from "../../lib/globalHotkey";
import { isMac } from "../../lib/platform";
import { Kbd, buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { RailSection } from "./settingsNav";

// TEMP-TRACE: what a press looks like while a row is recording. Remove after the diagnosis.
function tempTrace(message: string) {
  void import("@tauri-apps/api/core").then(({ invoke }) =>
    invoke("log_frontend_error", { kind: "shortcut-trace", message: `${Date.now()} ${message}`, detail: null }).catch(() => {}),
  );
}
window.addEventListener(
  "keydown",
  (e) => {
    if (!useShortcutsStore.getState().recordingId) return;
    const target = e.target as HTMLElement | null;
    tempTrace(
      `key=${JSON.stringify(e.key)} code=${e.code} meta=${e.metaKey} alt=${e.altKey} shift=${e.shiftKey} ctrl=${e.ctrlKey} altgr=${e.getModifierState("AltGraph")} chord=${eventToChord(e)} bindable=${(() => { const c = eventToChord(e); return c ? isBindable(c) : null; })()} prevented=${e.defaultPrevented} target=${target?.tagName}.${String(target?.className ?? "").slice(0, 40)} active=${document.activeElement?.tagName}`,
    );
  },
  true,
);
window.addEventListener("focusin", (e) => {
  if (!useShortcutsStore.getState().recordingId) return;
  tempTrace(`focusin ${(e.target as HTMLElement)?.tagName} role=${(e.target as HTMLElement)?.getAttribute?.("role")}`);
});
useShortcutsStore.subscribe((s, prev) => {
  if (s.recordingId !== prev.recordingId) tempTrace(`recording ${prev.recordingId} -> ${s.recordingId}`);
  if (s.overrides !== prev.overrides) tempTrace(`overrides ${JSON.stringify(s.overrides)}`);
});

/**
 * Captures the next chord the user presses and hands it back.
 *
 * Listens in the *capture* phase and swallows every key while active: the point is to record
 * combinations that are already bound to something (⌘B, Esc, ⌘,), which a bubble-phase listener
 * would only see after the app had already acted on them. The global shortcut handler separately
 * stands down while `recordingId` is set.
 */
function useChordRecorder(active: boolean, onCapture: (chord: string | null) => void, onCancel: () => void) {
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      // Backspace clears the binding rather than being recorded as one — an action with no key
      // is a legitimate choice, and there's no other way to express it.
      if (e.key === "Backspace" || e.key === "Delete") {
        onCapture(null);
        return;
      }
      const chord = eventToChord(e);
      if (!chord || !isBindable(chord)) return;
      onCapture(chord);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, onCapture, onCancel]);
}

const ACCELERATOR_ARROWS: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→" };

/**
 * A combination as the set of keys pressed, in this platform's spelling. The registry's chords, the
 * switcher's and the system-wide accelerator each have a vocabulary of their own; key caps are the
 * one form all three come out in, so it is the one they can be held against each other in.
 */
function pressedKeys(caps: string[]): string {
  return caps
    .map((cap) => ACCELERATOR_ARROWS[cap] ?? cap)
    .sort()
    .join(" ");
}

/**
 * The presses held by the chords outside the registry — the switcher's two drums and the quick-ask
 * hotkey — as `pressedKeys`. A registry chord on one of them never fires: the switcher takes the
 * press in the capture phase, and the system takes the quick-ask before the window ever sees it.
 */
function useReservedPresses(): Set<string> {
  const lock = useSwitcherLockStore((s) => s.chords);
  const quickAsk = useQuickAskHotkeyStore((s) => s.accelerator);
  const mac = isMac();
  const presses = new Set<string>();
  for (const axis of ["workspace", "repo"] as const) {
    const chord = lock[axis];
    if (!chord) continue;
    for (const arrow of LOCK_ARROWS[axis]) presses.add(pressedKeys([...lockChordKeycaps(chord, mac), ...chordKeycaps(arrow)]));
  }
  if (quickAsk) presses.add(pressedKeys(acceleratorKeycaps(quickAsk, mac)));
  return presses;
}

/** What each switcher row is called, explains, and shows after its chord. */
const LOCK_ROWS = {
  workspace: { label: "lock.workspaces", hint: "lock.hintWorkspaces", arrows: "←→" },
  repo: { label: "lock.repositories", hint: "lock.hintRepositories", arrows: "↑↓" },
} as const satisfies Record<LockAxis, { label: TranslationKey; hint: TranslationKey; arrows: string }>;

/**
 * The workspace and repository switcher's chords, one row per drum (split 2026-10-09 — one row for
 * both left a rebind guessing which it changed): what is held while ←/→ roll workspaces, and what
 * while ↑/↓ roll repositories. Their own rows because they are not registry commands: they act on
 * release, and spell Control literally on macOS (see `SwitcherLock`).
 */
function SwitcherLockRows() {
  useEffect(() => {
    void useSwitcherLockStore.getState().init();
    // Leaving the section mid-capture would otherwise keep the switcher standing down.
    return () => useSwitcherLockStore.getState().setRecording(null);
  }, []);
  return (
    <>
      <SwitcherLockRow axis="workspace" />
      <SwitcherLockRow axis="repo" />
    </>
  );
}

/** One drum's chord, recorded by pressing it with an arrow — the arrows are fixed. Backspace
 *  switches it off; two modifiers at least. */
function SwitcherLockRow({ axis }: { axis: LockAxis }) {
  const t = useT();
  const chord = useSwitcherLockStore((s) => s.chords[axis]);
  const recording = useSwitcherLockStore((s) => s.recording === axis);
  const mac = isMac();
  const row = LOCK_ROWS[axis];

  useEffect(() => {
    if (!recording) return;
    const store = useSwitcherLockStore.getState();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        store.setRecording(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        store.setRecording(null);
        void store.setChord(axis, null);
        return;
      }
      if (!e.key.startsWith("Arrow")) return;
      const next = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
      // One modifier alone stays listening: it belongs to the text under the cursor.
      if (!usableLockChord(next)) return;
      store.setRecording(null);
      void store.setChord(axis, next);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording, axis]);

  const isDefault = sameLockChord(chord, DEFAULT_LOCK_CHORD);

  return (
    <div className="flex min-h-[42px] items-center gap-3 border-b border-[var(--cf-border)] py-1.5">
      <div className="min-w-0 flex-1">
        <Tooltip label={t(row.label)} description={t(row.hint)}>
          <p className="break-words text-[13px] leading-snug text-[var(--cf-text)]">{t(row.label)}</p>
        </Tooltip>
      </div>
      <button
        type="button"
        onClick={() => useSwitcherLockStore.getState().setRecording(recording ? null : axis)}
        aria-pressed={recording}
        aria-label={t(row.label)}
        className={`flex h-7 min-w-[120px] items-center justify-center gap-1 rounded-md px-2 transition-colors duration-100 ${
          recording
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent)]"
            : "bg-[var(--cf-surface)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
        }`}
      >
        {recording ? (
          <span className="text-[11px] font-medium">{t("shortcuts.recording")}</span>
        ) : chord ? (
          <>
            {lockChordKeycaps(chord, mac).map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
            <span className="pl-0.5 text-[11px] text-[var(--cf-text-muted)]">+ {row.arrows}</span>
          </>
        ) : (
          <span className="text-[11px] italic text-[var(--cf-text-faint)]">{t("shortcuts.unbound")}</span>
        )}
      </button>
      <Tooltip label={t("shortcuts.clear")}>
        <button
          type="button"
          onClick={() => void useSwitcherLockStore.getState().setChord(axis, null)}
          disabled={!chord}
          aria-label={t("shortcuts.clear")}
          className={iconButtonClass({ size: "md" })}
        >
          <X size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t("shortcuts.resetOne")}>
        <button
          type="button"
          onClick={() => void useSwitcherLockStore.getState().reset(axis)}
          disabled={isDefault}
          aria-label={t("shortcuts.resetOne")}
          className={iconButtonClass({ size: "md" })}
        >
          <RotateCcw size={14} />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The one shortcut that is not the app's: the system-wide chord that raises the quick-ask box from
 * any application. Its own row because it is bound with the operating system rather than listened
 * for in this window — recorded by physical key, refusable by the system (another app may own it),
 * and switchable off, which on Windows used to be the only fix for losing the system's own
 * Alt+Space window menu. See `quickAskHotkeyStore`.
 */
function QuickAskHotkeyRow() {
  const t = useT();
  const { accelerator, defaultAccelerator, loaded, error } = useQuickAskHotkeyStore();
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    void useQuickAskHotkeyStore.getState().load();
  }, []);

  useEffect(() => {
    if (!recording) return;
    const store = useQuickAskHotkeyStore.getState();
    // Freed while recording: bound, the chord would raise the ask box instead of reaching here.
    void store.suspend();
    let settled = false;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        settled = true;
        setRecording(false);
        void store.turnOff();
        return;
      }
      const next = acceleratorFromKey(e, isMac());
      if (!next) return;
      settled = true;
      setRecording(false);
      void store.set(next);
    };
    window.addEventListener("keydown", handler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      // Cancelled, or the section closed mid-capture: the chord it had goes back on.
      if (!settled) void store.resume();
    };
  }, [recording]);

  if (!loaded) return null;
  const isDefault = accelerator === defaultAccelerator;

  return (
    <div className="flex min-h-[42px] items-center gap-3 border-b border-[var(--cf-border)] py-1.5">
      <div className="min-w-0 flex-1">
        <Tooltip label={t("quickAsk.hotkeyLabel")} description={t("quickAsk.hotkeyHint")}>
          <p className="break-words text-[13px] leading-snug text-[var(--cf-text)]">{t("quickAsk.hotkeyLabel")}</p>
        </Tooltip>
        {error && !recording && (
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--cf-danger)]" title={error}>
            <AlertTriangle size={12} className="shrink-0" />
            {t("quickAsk.hotkeyRefused")}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => setRecording((on) => !on)}
        aria-pressed={recording}
        aria-label={t("quickAsk.hotkeyLabel")}
        className={`flex h-7 min-w-[120px] items-center justify-center gap-1 rounded-md px-2 transition-colors duration-100 ${
          recording
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent)]"
            : "bg-[var(--cf-surface)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
        }`}
      >
        {recording ? (
          <span className="text-[11px] font-medium">{t("shortcuts.recording")}</span>
        ) : accelerator ? (
          acceleratorKeycaps(accelerator, isMac()).map((key, i) => <Kbd key={`${key}-${i}`}>{key}</Kbd>)
        ) : (
          <span className="text-[11px] italic text-[var(--cf-text-faint)]">{t("quickAsk.hotkeyOff")}</span>
        )}
      </button>
      <Tooltip label={t("quickAsk.hotkeyTurnOff")}>
        <button
          type="button"
          onClick={() => void useQuickAskHotkeyStore.getState().turnOff()}
          disabled={!accelerator}
          aria-label={t("quickAsk.hotkeyTurnOff")}
          className={iconButtonClass({ size: "md" })}
        >
          <X size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t("shortcuts.resetOne")}>
        <button
          type="button"
          onClick={() => void useQuickAskHotkeyStore.getState().reset()}
          disabled={isDefault}
          aria-label={t("shortcuts.resetOne")}
          className={iconButtonClass({ size: "md" })}
        >
          <RotateCcw size={14} />
        </button>
      </Tooltip>
    </div>
  );
}

export function ShortcutsSettings() {
  const t = useT();
  const overrides = useShortcutsStore((s) => s.overrides);
  const recordingId = useShortcutsStore((s) => s.recordingId);
  const setRecording = useShortcutsStore((s) => s.setRecording);
  const setBinding = useShortcutsStore((s) => s.setBinding);
  const resetBinding = useShortcutsStore((s) => s.resetBinding);
  const resetAll = useShortcutsStore((s) => s.resetAll);

  const assigned = activeChords(overrides);
  const reserved = useReservedPresses();

  // Read here rather than only by their rows, which live in the General pane: the warnings below
  // need both chords on every pane.
  useEffect(() => {
    void useSwitcherLockStore.getState().init();
    void useQuickAskHotkeyStore.getState().load();
  }, []);

  const capture = useCallback(
    (chord: string | null) => {
      const id = useShortcutsStore.getState().recordingId;
      if (!id) return;
      // Assigning a chord that's already taken moves it: the previous owner is left unbound
      // rather than both firing, which would make one of them silently dead.
      if (chord) {
        const previous = activeChords(useShortcutsStore.getState().overrides).get(chord);
        if (previous && previous !== id) void setBinding(previous, null);
      }
      void setBinding(id, chord);
      setRecording(null);
    },
    [setBinding, setRecording],
  );
  const cancel = useCallback(() => setRecording(null), [setRecording]);

  useChordRecorder(recordingId !== null, capture, cancel);

  // Leaving the section mid-capture would otherwise keep the global handler disabled.
  useEffect(() => () => useShortcutsStore.getState().setRecording(null), []);

  const rowFor = (id: ShortcutId) => {
    const command = SHORTCUT_COMMANDS.find((c) => c.id === id)!;
    const chord = bindingFor(id, overrides);
    const recording = recordingId === id;
    const customized = id in overrides;
    const duplicate = chord ? assigned.get(chord) !== id || reserved.has(pressedKeys(chordKeycaps(chord))) : false;

    return (
      <div key={id} className="flex min-h-[42px] items-center gap-3 border-b border-[var(--cf-border)] py-1.5 last:border-0">
        <div className="min-w-0 flex-1">
          {/* Wraps: the name of a shortcut is the only thing telling you which row you are rebinding. */}
          <p className="break-words text-[13px] leading-snug text-[var(--cf-text)]">{t(command.labelKey)}</p>
          {/* One warning for every collision: another command in the table (the editor's chords are
              ordinary commands there), or the switcher's or the quick-ask's chord, which take the
              press before any command can. */}
          {duplicate && !recording && (
            <p className="mt-0.5 flex items-center gap-1 text-[11px] text-[var(--cf-warning)]">
              <AlertTriangle size={12} className="shrink-0" />
              {t("shortcuts.conflict")}
            </p>
          )}
        </div>

        {/* The chord well: the keys as key caps in an outlined field, lit in the accent while it is
            listening for the next press. */}
        <button
          type="button"
          onClick={() => setRecording(recording ? null : id)}
          aria-pressed={recording}
          className={`flex h-7 min-w-[120px] items-center justify-center gap-1 rounded-md px-2 transition-colors duration-100 ${
            recording
              ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent)]"
              : "bg-[var(--cf-surface)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
          }`}
        >
          {recording ? (
            <span className="text-[11px] font-medium">{t("shortcuts.recording")}</span>
          ) : chord ? (
            chordKeycaps(chord).map((key, i) => <Kbd key={`${key}-${i}`}>{key}</Kbd>)
          ) : (
            <span className="text-[11px] italic text-[var(--cf-text-faint)]">{t("shortcuts.unbound")}</span>
          )}
        </button>

        <Tooltip label={t("shortcuts.clear")}>
          <button
            type="button"
            onClick={() => void setBinding(id, null)}
            disabled={!chord}
            aria-label={t("shortcuts.clear")}
            className={iconButtonClass({ size: "md" })}
          >
            <X size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t("shortcuts.resetOne")}>
          <button
            type="button"
            onClick={() => void resetBinding(id)}
            disabled={!customized}
            aria-label={t("shortcuts.resetOne")}
            className={iconButtonClass({ size: "md" })}
          >
            <RotateCcw size={14} />
          </button>
        </Tooltip>
      </div>
    );
  };

  // One pane per group — the panes are the catalog's, whose ids are `ShortcutGroup`s. The reset
  // is under every one of them because it resets every one of them, and a list rebound across three
  // panes should not have to be walked back to find it.
  return (
    <RailSection section="keybindings" title={t("shortcuts.title")} hint={t("settings.keybindingsHint")} fallback="general">
      {(tab) => (
        <>
          {/* First in General: the one chord that works from any application, not only here. */}
          {tab === "general" && <QuickAskHotkeyRow />}
          {tab === "general" && <SwitcherLockRows />}
          {SHORTCUT_COMMANDS.filter((command) => command.group === tab).map((command) => rowFor(command.id))}

          <div className="mt-4 border-t border-[var(--cf-border)] pt-4">
            <button
              type="button"
              onClick={() => void resetAll()}
              disabled={Object.keys(overrides).length === 0}
              className={buttonClass({ variant: "secondary", size: "md" })}
            >
              <RotateCcw size={14} />
              {t("shortcuts.resetAll")}
            </button>
          </div>
        </>
      )}
    </RailSection>
  );
}
