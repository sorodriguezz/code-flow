import { useEffect } from "react";
import { useShortcutsStore, activeChords, bindingFor } from "../state/shortcutsStore";
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

/**
 * A repository satellite's title-bar chords, and only those.
 *
 * Not `useGlobalShortcuts`: that binds *every* command, and most of them — switch view, open
 * settings, the palette, the workspace switcher — are ways to make a window show something else,
 * which is the one thing a satellite must not do. Binding the whole table there would give a
 * one-repository window a keystroke for the app rail it does not have.
 *
 * These are different in kind. Every one of them acts on the repository the window already holds,
 * through this window's own `repoStore`, and they are the exact chords the controls beside them
 * advertise in their tooltips — `useShortcutHint` reads the same bindings whichever window it
 * renders in, so without this the satellite's fetch button promised ⌘⇧R and nothing happened.
 *
 * **`branch.switcher` is on the list even though it opens a dialog**, which looks at first like the
 * navigation this hook exists to keep out. It is not: the list it opens is this repository's
 * branches, every action in it is a git command against this working copy, and it can no more make
 * the window show another repository than pull can. Its `run` toggles `uiStore`, and `uiStore` is
 * per webview — so the flag it sets is this window's own, and `SatelliteTitleBar` is what draws the
 * dialog from it. That is the test: does it act on the one thing this window holds?
 *
 * Rebinding still works: the chords are read from the same overrides the main window uses, so a
 * user who moves fetch to F5 moves it in both windows at once.
 */
export function useRemoteActionShortcuts(): void {
  const overrides = useShortcutsStore((s) => s.overrides);

  useEffect(() => {
    const chords = new Map<string, () => void>();
    for (const id of ["git.fetch", "git.pull", "git.push", "branch.switcher"] as const) {
      const chord = bindingFor(id, overrides);
      const run = SHORTCUT_BY_ID.get(id)?.run;
      if (chord && run) chords.set(chord, run);
    }
    if (chords.size === 0) return;

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      const chord = eventToChord(e);
      if (!chord) return;
      const run = chords.get(chord);
      if (!run) return;
      // The same two guards the main handler applies, for the same reasons — see above. All three
      // of these default to Mod chords, but they are rebindable, so a user who puts fetch on F5
      // must not have it fire into a commit message.
      if (!usesMod(chord) && !isFunctionKey(chord) && isTypingTarget(e.target)) return;
      e.preventDefault();
      run();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [overrides]);
}
