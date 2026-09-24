import { useCallback, useEffect } from "react";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useShortcutsStore, activeChords, bindingFor } from "../../state/shortcutsStore";
import { SHORTCUT_COMMANDS, type ShortcutId } from "../../lib/shortcuts";
import { chordKeycaps, eventToChord, isBindable } from "../../lib/keys";
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
