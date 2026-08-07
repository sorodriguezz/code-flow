import type { Monaco } from "@monaco-editor/react";
import type { IDisposable, editor as MonacoEditor } from "monaco-editor";
import { SHORTCUT_COMMANDS } from "./shortcuts";
import { chordToMonaco } from "./monacoKeys";
import { eventToChord } from "./keys";
import { bindingFor, type BindingOverrides } from "../state/shortcutsStore";

/**
 * Makes the editor's own keys whatever the user set — by **dispatching them ourselves** rather than
 * by describing them to Monaco.
 *
 * # Why not Monaco's keybinding table
 *
 * That was the first design, and it cannot be made right. Monaco takes a `KeyCode`, which names a
 * key on a *US* keyboard, and resolves it against the live layout — `KeyCode.Slash` means "whatever
 * types `/` here", which on a Spanish keyboard is ⇧7. This app records chords from
 * `KeyboardEvent.key`, the character the keystroke actually produced. The two agree on a US layout
 * and diverge everywhere else, in ways that are not a fixed offset you can correct for: `}` is ⇧]
 * on US and ⌥⇧ of another key on Latin American, and handing Monaco `Shift|BracketRight` for it got
 * resolved back to plain `⌘]` — which is Monaco's own *indent* command. The shortcut did not fail
 * silently; it did something else.
 *
 * So the translation layer is gone. The chord the user recorded is compared against the chord the
 * keystroke produces, both computed by `eventToChord`, and the matching command is triggered on the
 * editor by id. There is no second notion of what a key is, so there is nothing left to disagree.
 *
 * # Where it listens
 *
 * On the window in capture phase, ahead of Monaco's own handler, and only for events inside an
 * editor — minus the widgets that host a text field of their own. That exclusion matters: the find
 * box, the replace box and the rename box all live inside the editor's DOM node, and ⌘Z in the find
 * field has to undo *typing in the find field*.
 *
 * The test is "inside a `.monaco-inputbox`", not "is the editor's textarea". The textarea's class is
 * Monaco's business and it changes — it is `ime-text-area` in this version and was `inputarea`
 * before — so keying off it means the shortcuts quietly stop working on an upgrade, which is a
 * failure nobody would trace back to a CSS class. `monaco-inputbox` is the wrapper every one of
 * those widgets shares.
 *
 * Global rather than per-instance, deliberately — the same reason it always was. "How do I comment a
 * line" should not have a different answer depending on whether the caret is in a file, a SQL
 * console or a request body.
 *
 * # What is still removed from Monaco's table
 *
 * Only the shipped chord of a command the user has actually *moved*. Left in place it would keep
 * firing from its old key, so a rebinding would appear not to have taken. A command still on its
 * default needs no removal: this handler swallows the key before Monaco's table is consulted, and
 * leaving Monaco's entry alone means the action still works in any context this handler
 * deliberately stays out of.
 */
export function installEditorShortcuts(monaco: Monaco, overrides: BindingOverrides): IDisposable {
  const removals: { keybinding: number; command: string | null }[] = [];
  /** chord → Monaco command id, for the keys this handler owns. */
  const dispatch = new Map<string, string>();

  for (const command of SHORTCUT_COMMANDS) {
    if (!command.monacoCommand) continue;
    const chord = bindingFor(command.id, overrides);
    // A cleared binding is cleared: no dispatch entry, and the shipped key comes off so it cannot
    // stand in for the one the user removed.
    if (chord) dispatch.set(chord, command.monacoCommand);
    if (chord === command.defaultChord) continue;
    const original = chordToMonaco(command.defaultChord, monaco);
    if (original !== null) removals.push({ keybinding: original, command: null });
  }

  const applied = monaco.editor.addKeybindingRules(removals);

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest(".monaco-inputbox")) return;
    const chord = eventToChord(event);
    if (!chord) return;
    const commandId = dispatch.get(chord);
    if (!commandId) return;
    const editor = monaco.editor
      .getEditors()
      .find((candidate: MonacoEditor.ICodeEditor) => candidate.getDomNode()?.contains(target));
    if (!editor) return;
    // Swallowed before Monaco's own table is consulted — otherwise a chord the user moved onto a
    // key Monaco already uses would run both.
    event.preventDefault();
    event.stopPropagation();
    editor.trigger("cf-shortcut", commandId, null);
  };

  window.addEventListener("keydown", onKeyDown, true);

  return {
    dispose: () => {
      window.removeEventListener("keydown", onKeyDown, true);
      applied.dispose();
    },
  };
}
