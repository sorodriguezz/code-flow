import { useState, type ReactNode } from "react";
import { Check, GitCommitHorizontal } from "lucide-react";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { LanguagePicker } from "./LanguagePicker";
import { FileGlyph } from "../common/FileGlyph";
import { Tooltip } from "../common/Tooltip";
import { useCursorBlameStore } from "../../state/cursorBlameStore";
import { useEditorStatusStore, type LineEnding } from "../../state/editorStatusStore";
import { extensionOf, useLanguageOverrideStore } from "../../state/languageOverrideStore";
import { useT } from "../../state/languageStore";

/**
 * The Editor's own status line: who last changed the caret's line, where the caret is, how the file
 * is indented, its encoding and line endings, and what language it was opened as — the user's ask
 * (2026-09-25) with VS Code's bar as the reference, "una línea extra pero solo para Editor".
 *
 * A row of the Editor view rather than more items in the app's status bar: that bar is about the
 * repository and the machine and is on screen in every view, while all of this is about one file and
 * means nothing anywhere else. It describes the pane that has focus (see `editorStatusStore`) and is
 * empty while no pane shows a file in Monaco.
 *
 * The line blame moved here from the app bar for the same reason, and does not follow the setting:
 * that switch is the in-code annotation's alone (the user, 2026-09-25), so this always says who last
 * changed the caret's line. An empty text — a selection, several carets, a blame in flight on a newly
 * opened file — draws nothing.
 */
export function EditorStatusLine() {
  const t = useT();
  const status = useEditorStatusStore((s) => s.status);
  const actions = useEditorStatusStore((s) => s.actions);
  const blame = useCursorBlameStore((s) => s.entry?.text ?? "");
  const [menu, setMenu] = useState<{ items: MenuItem[]; heading: string; anchor: DOMRect } | null>(null);
  const [languageAnchor, setLanguageAnchor] = useState<DOMRect | null>(null);
  const picked = useLanguageOverrideStore((s) => (status ? s.files[status.fileKey] : undefined));
  const associated = useLanguageOverrideStore((s) => {
    const extension = status ? extensionOf(status.path) : null;
    return extension ? s.extensions[extension] : undefined;
  });

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>, heading: string, items: MenuItem[]) => {
    setMenu({ heading, items, anchor: event.currentTarget.getBoundingClientRect() });
  };

  /** A check in a fixed-width box, so checked and unchecked rows line their labels up. */
  const mark = (on: boolean): ReactNode => (
    <span className="flex w-3.5 shrink-0 justify-center">{on && <Check size={13} />}</span>
  );

  const extension = status ? extensionOf(status.path) : null;

  return (
    <div className="flex h-6 shrink-0 items-center justify-end gap-0.5 border-t border-[var(--cf-border)] px-2 text-[12px] text-[var(--cf-text-muted)]">
      {blame && (
        <span className="mr-1 flex min-w-0 shrink items-center gap-1.5 px-1.5" title={t("editor.status.blameTip")}>
          <GitCommitHorizontal size={13} className="shrink-0" />
          <span className="min-w-0 truncate">{blame}</span>
        </span>
      )}
      {status && actions && (
        <>
          <Tooltip side="top" label={t("editor.status.goToLine")}>
            <button onClick={actions.goToLine} className={itemClass}>
              <span className="tabular-nums">
                {t("editor.status.position", { line: status.line, column: status.column })}
                {status.cursors > 1
                  ? ` · ${t("editor.status.cursors", { count: status.cursors })}`
                  : status.selected > 0
                    ? ` ${t("editor.status.selected", { count: status.selected })}`
                    : ""}
              </span>
            </button>
          </Tooltip>

          <button
            className={itemClass}
            aria-haspopup="menu"
            onClick={(event) =>
              openMenu(event, t("editor.status.indentation"), [
                {
                  label: t("editor.status.indentUsingSpaces"),
                  leading: mark(status.insertSpaces),
                  onClick: () => actions.setIndentation(true, status.tabSize),
                },
                {
                  label: t("editor.status.indentUsingTabs"),
                  leading: mark(!status.insertSpaces),
                  onClick: () => actions.setIndentation(false, status.tabSize),
                },
                ...[2, 4, 8].map((size, at) => ({
                  label: t("editor.status.indentSize", { size }),
                  leading: mark(status.tabSize === size),
                  separated: at === 0,
                  onClick: () => actions.setIndentation(status.insertSpaces, size),
                })),
                {
                  label: t("editor.status.detectIndentation"),
                  leading: mark(false),
                  separated: true,
                  onClick: actions.detectIndentation,
                },
                {
                  label: status.insertSpaces ? t("editor.status.convertToSpaces") : t("editor.status.convertToTabs"),
                  leading: mark(false),
                  onClick: () => actions.convertIndentation(status.insertSpaces),
                },
              ])
            }
          >
            {status.insertSpaces
              ? t("editor.status.spaces", { size: status.tabSize })
              : t("editor.status.tabs", { size: status.tabSize })}
          </button>

          {/* Not a control: the app reads and writes files as UTF-8 and nothing else, so there is
              nothing to choose — the label says what is true, and the tooltip why it cannot change. */}
          <span className={staticClass} title={t("editor.status.encoding")}>
            UTF-8
          </span>

          <button
            className={itemClass}
            aria-haspopup="menu"
            title={t("editor.status.eolTip", { eol: status.eol })}
            onClick={(event) =>
              openMenu(
                event,
                t("editor.status.eol"),
                (["LF", "CRLF"] as LineEnding[]).map((eol) => ({
                  label: eol === "LF" ? t("editor.status.eolLf") : t("editor.status.eolCrlf"),
                  leading: mark(status.eol === eol),
                  onClick: () => {
                    if (eol !== status.eol) actions.setEol(eol);
                  },
                })),
              )
            }
          >
            {status.eol}
          </button>

          {/* Chosen by hand from here (`LanguagePicker`), or detected — and the tooltip says which. The
              mousedown is kept from the picker's outside-click while it is open, so a second press on
              this closes it instead of closing and reopening it. */}
          <button
            className={`${itemClass} gap-1.5`}
            aria-haspopup="dialog"
            aria-expanded={languageAnchor !== null}
            title={
              picked
                ? t("editor.status.languagePicked")
                : associated
                  ? t("editor.status.languageAssociated", { ext: extension ?? "" })
                  : extension
                    ? t("editor.status.languageByExt", { ext: extension })
                    : t("editor.status.languageByName")
            }
            onMouseDown={(event) => {
              if (languageAnchor) event.stopPropagation();
            }}
            onClick={(event) => {
              // Measured here, not inside the updater: React runs that later, by which time the
              // event's `currentTarget` has been cleared — reading it there took the whole view down.
              const rect = event.currentTarget.getBoundingClientRect();
              setLanguageAnchor((open) => (open ? null : rect));
            }}
          >
            <FileGlyph path={status.path} size={13} />
            {status.languageId === "plaintext" ? t("editor.status.plainText") : status.languageName}
          </button>
        </>
      )}
      {languageAnchor && status && (
        <LanguagePicker
          anchor={languageAnchor}
          path={status.path}
          fileKey={status.fileKey}
          onClose={() => setLanguageAnchor(null)}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.anchor.left}
          y={menu.anchor.top}
          heading={menu.heading}
          items={menu.items}
          anchor={{
            top: menu.anchor.top,
            bottom: menu.anchor.bottom,
            left: menu.anchor.left,
            right: menu.anchor.right,
            align: "end",
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

const itemClass =
  "flex h-5 shrink-0 items-center whitespace-nowrap rounded-[4px] px-1.5 hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]";
const staticClass = "flex h-5 shrink-0 items-center whitespace-nowrap px-1.5";
