import { createContext, useContext, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditorNS, IDisposable } from "monaco-editor";
import { CODE_FONT_FAMILY, OVERFLOW_SAFE_OPTIONS } from "../../../lib/monacoSetup";

/** Fixed rather than derived from the font size, so the placeholder a cell shows before its editor
 *  mounts is exactly as tall as the editor that replaces it — no jump when it does. */
export const CELL_LINE_HEIGHT = 19;
const CELL_PADDING = 6;

/** The notebook's scrolling list, which is what "near the screen" is measured against. */
export const CellScrollRoot = createContext<HTMLElement | null>(null);

export function cellHeight(source: string): number {
  const lines = Math.max(1, source.split("\n").length);
  return lines * CELL_LINE_HEIGHT + CELL_PADDING * 2;
}

/** The keys a cell editor hands to the notebook instead of typing them — see `onKey`. */
export type CellKey = "runAdvance" | "runInPlace" | "escape" | "save";

/**
 * A code cell's editor: Monaco sized to its content, so the notebook scrolls and the cell does not.
 *
 * **Mounted when it comes near the screen, and not before.** A notebook of two hundred cells would
 * otherwise be two hundred Monaco instances created on open; until then the cell draws its text as
 * a plain block of exactly the same height, so the list does not move when the editor arrives.
 * Once mounted it stays — the model (and its undo history) is kept by path either way.
 *
 * **Jupyter's keys are handled per editor** (`onKeyDown`), not through Monaco's keybinding table,
 * whose dynamic bindings are shared between editors and would run ⇧↵ in whichever cell registered
 * last. ⇧↵, ⌘/Ctrl↵ and Escape go to the notebook; so does ⌘S when nothing ahead of Monaco (the
 * editor's shortcut dispatcher) already took it — the notebook's save is its tab's save.
 */
export function CellEditor({
  modelPath,
  language,
  value,
  theme,
  autoFocus,
  readOnly = false,
  onChange,
  onKey,
  onFocus,
  onReady,
}: {
  modelPath: string;
  language: string;
  value: string;
  theme: string;
  autoFocus: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onKey: (key: CellKey) => void;
  onFocus: () => void;
  onReady?: (editor: MonacoEditorNS.IStandaloneCodeEditor | null) => void;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const scrollRoot = useContext(CellScrollRoot);
  const [live, setLive] = useState(autoFocus);
  const [height, setHeight] = useState(() => cellHeight(value));
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const valueRef = useRef(value);
  valueRef.current = value;
  const disposables = useRef<IDisposable[]>([]);

  useEffect(() => {
    if (live || !holder.current) return;
    if (typeof IntersectionObserver === "undefined") {
      setLive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setLive(true);
      },
      { root: scrollRoot, rootMargin: "600px 0px" },
    );
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [live, scrollRoot]);

  useEffect(() => {
    if (autoFocus) setLive(true);
  }, [autoFocus]);

  useEffect(() => {
    if (autoFocus && editorRef.current && !editorRef.current.hasTextFocus()) editorRef.current.focus();
  }, [autoFocus]);

  useEffect(
    () => () => {
      for (const disposable of disposables.current) disposable.dispose();
      disposables.current = [];
      onReady?.(null);
    },
    // Only on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
    onReady?.(editor);
    // A model kept from an earlier mount (the tab was switched away and back) holds the text it had
    // then; the cell may have changed since — a reload, the JSON view — and the wrapper only pushes
    // *changes* of `value`, so it would never say.
    const model = editor.getModel();
    if (model && model.getValue() !== valueRef.current) {
      editor.executeEdits("notebook", [{ range: model.getFullModelRange(), text: valueRef.current }]);
    }
    const sync = () => {
      const next = Math.max(CELL_LINE_HEIGHT + CELL_PADDING * 2, editor.getContentHeight());
      setHeight(next);
      const width = holder.current?.clientWidth ?? 0;
      if (width > 0) editor.layout({ width, height: next });
    };
    disposables.current.push(
      editor.onDidContentSizeChange(sync),
      editor.onDidFocusEditorText(() => onFocusRef.current()),
      editor.onKeyDown((event) => {
        const e = event.browserEvent;
        // Suggestions, parameter hints and the find box own Enter and Escape while they are open.
        const widgetOpen = !!editor
          .getDomNode()
          ?.querySelector(".suggest-widget.visible, .parameter-hints-widget.visible, .find-widget.visible");
        const mod = e.metaKey || e.ctrlKey;
        let key: CellKey | null = null;
        if (e.key === "Enter" && e.shiftKey && !mod && !e.altKey) key = "runAdvance";
        else if (e.key === "Enter" && mod && !e.shiftKey && !e.altKey) key = "runInPlace";
        else if (e.key === "Escape" && !widgetOpen) key = "escape";
        else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") key = "save";
        if (!key || (widgetOpen && key !== "save")) return;
        event.preventDefault();
        event.stopPropagation();
        onKeyRef.current(key);
      }),
    );
    // The width follows the notebook: a resized pane re-lays every live cell out.
    if (holder.current && typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => sync());
      observer.observe(holder.current);
      disposables.current.push({ dispose: () => observer.disconnect() });
    }
    sync();
    if (autoFocus) editor.focus();
  };

  return (
    <div ref={holder} style={{ height }} className="relative w-full">
      {live ? (
        <Editor
          height={height}
          path={modelPath}
          language={language}
          value={value}
          theme={theme}
          keepCurrentModel
          onChange={(next) => onChange(next ?? "")}
          onMount={handleMount}
          loading={<CellPlaceholder text={value} />}
          options={{
            ...OVERFLOW_SAFE_OPTIONS,
            fontSize: 13,
            lineHeight: CELL_LINE_HEIGHT,
            fontFamily: CODE_FONT_FAMILY,
            minimap: { enabled: false },
            lineNumbers: "off",
            glyphMargin: false,
            folding: false,
            lineDecorationsWidth: 8,
            lineNumbersMinChars: 0,
            renderLineHighlight: "none",
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            overviewRulerBorder: false,
            scrollBeyondLastLine: false,
            automaticLayout: false,
            wordWrap: "off",
            padding: { top: CELL_PADDING, bottom: CELL_PADDING },
            // The notebook scrolls; a cell only scrolls sideways, for a line longer than the pane.
            scrollbar: { vertical: "hidden", horizontal: "auto", alwaysConsumeMouseWheel: false, useShadows: false },
            readOnly,
            contextmenu: true,
            tabSize: 4,
          }}
        />
      ) : (
        <CellPlaceholder text={value} />
      )}
    </div>
  );
}

function CellPlaceholder({ text }: { text: string }) {
  return (
    <pre
      aria-hidden="true"
      // Full width and at the top: as Monaco's `loading` element it sits in a box that centres it.
      className="m-0 w-full self-start overflow-hidden whitespace-pre px-2 text-left text-[13px] text-[var(--cf-text)]"
      style={{ fontFamily: CODE_FONT_FAMILY, lineHeight: `${CELL_LINE_HEIGHT}px`, paddingTop: CELL_PADDING, paddingBottom: CELL_PADDING }}
    >
      {text || " "}
    </pre>
  );
}
