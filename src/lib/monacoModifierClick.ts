import type * as Monaco from "monaco-editor";
import type { editor, IDisposable, IPosition, IRange } from "monaco-editor";
import { isMac } from "./platform";

/** The held keys of a mouse or keyboard event — the part of it this file reads. */
export interface HeldKeys {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether the keys held are the *other* "go to definition" modifier — the one Monaco ignores.
 *
 * Monaco has exactly one: Cmd on macOS, Ctrl everywhere else, and no option adds a second one
 * (`multiCursorModifier: "ctrlCmd"` only trades it for Alt). So someone with Ctrl+click in their
 * hands from VS Code on Windows, from JetBrains, or from any other editor, got the macOS context
 * menu instead of a jump — Monaco treats a Ctrl+click on a Mac as a right click on purpose
 * (`mouseHandler`'s `isMacintosh && e.leftButton && e.ctrlKey`). Rather than tell people which key
 * their OS wants, both keys do it everywhere: Monaco keeps answering its own, this answers the other.
 *
 * Exactly one of the two, and no Alt or Shift: Ctrl+Cmd, Alt+click (a second cursor) and
 * Shift+click (extend the selection) all mean something else and keep meaning it.
 */
export function isExtraDefinitionModifier(keys: HeldKeys, mac: boolean): boolean {
  if (keys.altKey || keys.shiftKey) return false;
  return mac ? keys.ctrlKey && !keys.metaKey : keys.metaKey && !keys.ctrlKey;
}

/**
 * The parts of Monaco's own Cmd+click contribution (`GotoDefinitionAtPositionEditorContribution`)
 * this file borrows. Reached through the public `getContribution`, but the two methods are not in
 * Monaco's typings, so each is checked before use: a release that renames them turns the extra
 * modifier into a no-op, never into a broken jump or an error.
 */
interface DefinitionGesture {
  /** Every registered provider for the model, asked at once — no side effects. */
  findDefinition(position: IPosition, token: Monaco.CancellationToken): Promise<unknown[] | null>;
  /** Moves the caret and jumps, with Monaco's "no definition found" message muted. */
  gotoDefinition(position: IPosition, openToSide: boolean): Promise<unknown>;
}

const CONTRIBUTION_ID = "editor.contrib.gotodefinitionatposition";

function definitionGesture(ed: editor.ICodeEditor): DefinitionGesture | null {
  const contribution = ed.getContribution(CONTRIBUTION_ID) as Partial<DefinitionGesture> | null;
  return contribution &&
    typeof contribution.findDefinition === "function" &&
    typeof contribution.gotoDefinition === "function"
    ? (contribution as DefinitionGesture)
    : null;
}

/**
 * Ctrl+click *and* Cmd+click go to the definition, on every OS, and say nothing when there is none.
 *
 * It is Monaco's own gesture, answered for the other key: the underline appears only once a
 * provider (tsserver, the language servers, the ranked text search) has actually found a
 * definition for the word under the pointer — on `import`, `const` or a comment nothing is drawn —
 * and the click runs Monaco's own muted jump, so a word with no definition is a click that does
 * nothing rather than a "no definition found" note over the code. A definition in another file
 * opens through the app's editor opener exactly as Cmd+click's does.
 */
export function installModifierClickDefinition(
  ed: editor.ICodeEditor,
  monaco: typeof Monaco,
  mac: boolean = isMac(),
): IDisposable {
  const link = ed.createDecorationsCollection();
  let underlined: IRange | null = null;
  /** Where the pointer last was over the text — so pressing the key while it rests shows the link. */
  let lastTarget: editor.IMouseTarget | null = null;
  /** A Ctrl+click on a Mac also fires `contextmenu`; this is the one we just turned into a jump. */
  let swallowContextMenu = false;
  /** Whether the extra key is down, as of the last event that said. */
  let held = false;
  /** The word being asked about, and the answer once it comes. One at a time: moving on cancels. */
  let probe: {
    key: string;
    range: IRange;
    source: Monaco.CancellationTokenSource;
    found: Promise<IRange | null>;
  } | null = null;

  const clear = () => {
    if (!underlined) return;
    underlined = null;
    link.clear();
  };

  const cancelProbe = () => {
    probe?.source.cancel();
    probe?.source.dispose();
    probe = null;
  };

  const wordRangeAt = (target: editor.IMouseTarget | null): IRange | null => {
    if (!target || target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !target.position) return null;
    const word = ed.getModel()?.getWordAtPosition(target.position);
    if (!word) return null;
    const line = target.position.lineNumber;
    return new monaco.Range(line, word.startColumn, line, word.endColumn);
  };

  /**
   * Asks the providers about the word under `target`, once per word per version of the text, and
   * resolves to the range to underline — the provider's own span when it gives one (an import's
   * whole module specifier), else the word — or `null` when there is no definition.
   */
  const ask = (target: editor.IMouseTarget | null): Promise<IRange | null> | null => {
    const range = wordRangeAt(target);
    const model = ed.getModel();
    const gesture = definitionGesture(ed);
    if (!range || !model || !gesture || !target?.position) {
      cancelProbe();
      return null;
    }
    const key = `${model.uri.toString()}@${model.getVersionId()}:${range.startLineNumber}:${range.startColumn}`;
    if (probe?.key === key) return probe.found;
    cancelProbe();
    const source = new monaco.CancellationTokenSource();
    const position = target.position;
    const found = gesture
      .findDefinition(position, source.token)
      .then((links) => {
        if (source.token.isCancellationRequested || !links?.length) return null;
        const origin = (links[0] as { originSelectionRange?: IRange }).originSelectionRange;
        return origin ?? range;
      })
      .catch(() => null);
    probe = { key, range, source, found };
    return found;
  };

  /** Underlines the word under `target` if — and once — it turns out to have a definition. */
  const underline = (target: editor.IMouseTarget | null) => {
    const pending = ask(target);
    if (!pending) return clear();
    const asked = probe;
    void pending.then((range) => {
      // Still the word under the pointer, and the key still down, by the time the answer came.
      if (probe !== asked || !held) return;
      if (!range) return clear();
      if (underlined && monaco.Range.equalsRange(underlined, range)) return;
      underlined = range;
      // Monaco's own class for its Cmd+hover link, so both gestures draw the identical underline.
      link.set([{ range, options: { inlineClassName: "goto-definition-link" } }]);
    });
  };

  const disposables: IDisposable[] = [
    ed.onMouseMove((e) => {
      lastTarget = e.target;
      held = isExtraDefinitionModifier(e.event, mac);
      if (held) underline(e.target);
      else clear();
    }),
    ed.onMouseLeave(() => {
      lastTarget = null;
      cancelProbe();
      clear();
    }),
    // On mouse *down*, not up: on a Mac, Monaco does not run its own press for a Ctrl+click at all
    // (no caret, no focus, no drag), and the browser follows it with `contextmenu` — whether a
    // matching mouse up ever arrives is the WebView's business.
    ed.onMouseDown((e) => {
      swallowContextMenu = false;
      if (!e.event.leftButton || !isExtraDefinitionModifier(e.event, mac)) return;
      const position = e.target.position;
      const pending = ask(e.target);
      if (!pending || !position) return;
      e.event.preventDefault();
      // The menu is swallowed even when the word turns out to have no definition: the click was
      // aimed at a jump, and a menu opening instead is exactly the surprise this exists to remove.
      swallowContextMenu = mac;
      const model = ed.getModel();
      void pending.then((range) => {
        clear();
        // Nothing found, or the editor moved on to another file while it was being asked: nothing
        // happens, and nothing is said.
        if (!range || ed.getModel() !== model) return;
        const gesture = definitionGesture(ed);
        if (!gesture) return;
        ed.focus();
        void gesture.gotoDefinition(position, false).catch(() => {});
      });
    }),
    // Pressing or letting go of the key while the pointer rests on a word, without moving it.
    ed.onKeyDown((e) => {
      held = isExtraDefinitionModifier(e, mac);
      if (held) underline(lastTarget);
      else clear();
    }),
    ed.onKeyUp((e) => {
      held = isExtraDefinitionModifier(e, mac);
      if (!held) clear();
    }),
    ed.onDidChangeModel(() => {
      cancelProbe();
      clear();
    }),
    ed.onDidBlurEditorText(() => {
      held = false;
      clear();
    }),
  ];

  /**
   * The context menu a Mac opens for that same Ctrl+click. Caught on the editor's container in the
   * capture phase, so it is stopped before it reaches Monaco's own listener deeper in the editor
   * and before the WebView's native menu. Only the one press just turned into a jump: a real right
   * click — `button` 2, Ctrl held or not — still opens the menu.
   */
  const container = ed.getContainerDomNode();
  const onContextMenu = (event: MouseEvent) => {
    if (!swallowContextMenu) return;
    swallowContextMenu = false;
    if (event.button !== 0 || !event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
  };
  container.addEventListener("contextmenu", onContextMenu, true);
  // A key let go in another window never reaches the editor's key up.
  const onWindowBlur = () => {
    held = false;
    clear();
  };
  window.addEventListener("blur", onWindowBlur);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const d of disposables) d.dispose();
    container.removeEventListener("contextmenu", onContextMenu, true);
    window.removeEventListener("blur", onWindowBlur);
    cancelProbe();
    link.clear();
  };
  disposables.push(ed.onDidDispose(dispose));
  return { dispose };
}
