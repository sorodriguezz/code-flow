import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useShortcutsStore, activeChords, bindingFor } from "../../state/shortcutsStore";
import { useQuickAskHotkeyStore } from "../../state/quickAskHotkeyStore";
import { lockChordKeycaps, usableLockChord, useSwitcherLockStore } from "../../state/switcherLockStore";
import { SHORTCUT_COMMANDS, type ShortcutId } from "../../lib/shortcuts";
import { chordKeycaps, eventToChord, isBindable } from "../../lib/keys";
import { acceleratorFromKey, acceleratorKeycaps } from "../../lib/globalHotkey";
import { isMac } from "../../lib/platform";
import { Kbd, buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { RailSection } from "./settingsNav";

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

/**
 * The workspace and repository switcher's chord: what is held while the arrows roll it (←/→
 * workspaces, ↑/↓ repositories), recorded by pressing it with any arrow — the arrows are fixed.
 * Its own row because it is not a registry command: it acts on release, and spells Control
 * literally on macOS (see `SwitcherLock`). Backspace switches it off; two modifiers at least.
 */
function SwitcherLockRow() {
  const t = useT();
  const chord = useSwitcherLockStore((s) => s.chord);
  const recording = useSwitcherLockStore((s) => s.recording);
  const mac = isMac();

  useEffect(() => {
    void useSwitcherLockStore.getState().init();
    // Leaving the section mid-capture would otherwise keep the switcher standing down.
    return () => useSwitcherLockStore.getState().setRecording(false);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const store = useSwitcherLockStore.getState();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        store.setRecording(false);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        store.setRecording(false);
        void store.setChord(null);
        return;
      }
      if (!e.key.startsWith("Arrow")) return;
      const next = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
      // One modifier alone stays listening: it belongs to the text under the cursor.
      if (!usableLockChord(next)) return;
      store.setRecording(false);
      void store.setChord(next);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording]);

  const isDefault = chord !== null && chord.ctrl && chord.shift && chord.alt && !chord.meta;

  return (
    <div className="flex min-h-[42px] items-center gap-3 border-b border-[var(--cf-border)] py-1.5">
      <div className="min-w-0 flex-1">
        <Tooltip label={t("lock.settingLabel")} description={t("lock.settingHint")}>
          <p className="break-words text-[13px] leading-snug text-[var(--cf-text)]">{t("lock.settingLabel")}</p>
        </Tooltip>
      </div>
      <button
        type="button"
        onClick={() => useSwitcherLockStore.getState().setRecording(!recording)}
        aria-pressed={recording}
        aria-label={t("lock.settingLabel")}
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
            <span className="pl-0.5 text-[11px] text-[var(--cf-text-muted)]">+ ←→↑↓</span>
          </>
        ) : (
          <span className="text-[11px] italic text-[var(--cf-text-faint)]">{t("shortcuts.unbound")}</span>
        )}
      </button>
      <Tooltip label={t("shortcuts.clear")}>
        <button
          type="button"
          onClick={() => void useSwitcherLockStore.getState().setChord(null)}
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
          onClick={() => void useSwitcherLockStore.getState().reset()}
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
    const duplicate = chord ? assigned.get(chord) !== id : false;

    return (
      <div key={id} className="flex min-h-[42px] items-center gap-3 border-b border-[var(--cf-border)] py-1.5 last:border-0">
        <div className="min-w-0 flex-1">
          {/* Wraps: the name of a shortcut is the only thing telling you which row you are rebinding. */}
          <p className="break-words text-[13px] leading-snug text-[var(--cf-text)]">{t(command.labelKey)}</p>
          {/* One warning now, because there is one kind of collision. The editor's chords used to
              be a separate list that could only be warned about; they are ordinary commands in the
              same table, so the duplicate check that always covered app actions covers them too. */}
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
          {tab === "general" && <SwitcherLockRow />}
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
