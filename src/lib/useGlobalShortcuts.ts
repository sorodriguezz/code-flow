import { useEffect } from "react";
import { useShortcutsStore, activeChords } from "../state/shortcutsStore";
import { SHORTCUT_BY_ID } from "./shortcuts";
import { eventToChord, isTypingTarget, usesMod } from "./keys";

/**
 * Binds every configured app shortcut to the window, once, from `App`.
 *
 * Listening in the bubble phase (not capture) is what keeps the editor authoritative over its own
 * keys: Monaco calls `preventDefault`/`stopPropagation` on the chords it handles, so those never
 * reach this handler at all. Everything the editor ignores does.
 */
export function useGlobalShortcuts(): void {
  const overrides = useShortcutsStore((s) => s.overrides);
  const recording = useShortcutsStore((s) => s.recordingId !== null);

  useEffect(() => {
    // While a row in settings is capturing keys, the app must not also *act* on them — otherwise
    // recording ⌘B would toggle the sidebar on the way in.
    if (recording) return;
    const chords = activeChords(overrides);

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const chord = eventToChord(e);
      if (!chord) return;
      const id = chords.get(chord);
      if (!id) return;
      // Shortcuts without ⌘/Ctrl (Alt+←, F-keys) would fight with text input, so they only fire
      // when the user isn't typing. Mod chords always fire, as they do in every editor.
      if (!usesMod(chord) && isTypingTarget(e.target)) return;
      e.preventDefault();
      SHORTCUT_BY_ID.get(id)?.run();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [overrides, recording]);
}
