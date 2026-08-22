import { useEffect } from "react";
import { useShortcutsStore, activeChords } from "../state/shortcutsStore";
import { useTourStore } from "../state/tourStore";
import { useDataDirsStore } from "../state/dataDirsStore";
import { SHORTCUT_BY_ID } from "./shortcuts";
import { eventToChord, isFunctionKey, isTypingTarget, usesMod } from "./keys";

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
  const tourActive = useTourStore((s) => s.active);
  const dataDirsBlocked = useDataDirsStore((s) => s.status !== null && !s.status.ok);

  useEffect(() => {
    // While a row in settings is capturing keys, the app must not also *act* on them — otherwise
    // recording ⌘B would toggle the sidebar on the way in.
    if (recording) return;
    // Same reasoning during the guided tour, which drives these panels from its own steps: ⌘J in
    // the middle of it would open a terminal dock the current step doesn't mention and the next
    // step would silently close again. The tour's own keys are bound in the capture phase, ahead
    // of this handler, so Escape and the arrows keep working.
    if (tourActive) return;
    // And while the app is refusing to hold data. `DataDirsNotice` draws an unclosable screen for
    // that, but a `fixed inset-0` div only stops the mouse: every chord here still reached
    // `command.run()` behind it, and the command palette — which renders at `z-50`, *below* that
    // screen — would mount invisible under the scrim with its input autofocused, take typing, and
    // run whatever was selected on Enter. Each of those writes rows into a database that is not the
    // user's, which is the single thing the screen exists to prevent.
    if (dataDirsBlocked) return;
    const chords = activeChords(overrides);

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const chord = eventToChord(e);
      if (!chord) return;
      const id = chords.get(chord);
      if (!id) return;
      // Shortcuts without ⌘/Ctrl would fight with text input, so they only fire when the user
      // isn't typing. Mod chords always fire, as they do in every editor.
      //
      // Function keys are the exception, and a deliberate one: they produce no text, so there is
      // nothing for them to fight with, and the editor actions people most want on one (F11 for a
      // bookmark, the way JetBrains binds it) are pressed with the caret in the code. Without this
      // they were bindable in settings and then silently dead in the only place they were for.
      if (!usesMod(chord) && !isFunctionKey(chord) && isTypingTarget(e.target)) return;
      // A command whose behaviour lives in Monaco has no `run`: inside the editor Monaco already
      // handled the chord and this handler never saw it, and outside the editor there is nothing
      // to do. Letting it fall through — rather than swallowing the key — is what keeps ⌘Z undoing
      // text in an ordinary input.
      const command = SHORTCUT_BY_ID.get(id);
      if (!command?.run) return;
      e.preventDefault();
      command.run();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [overrides, recording, tourActive, dataDirsBlocked]);
}
