import { useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { AlertTriangle, Braces } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";

/**
 * One document, editable as a document.
 *
 * **Why the whole document and not its cells.** The grid can say "set these fields to these
 * strings", which is everything a table needs and not enough for a collection: removing a field,
 * reordering an array, turning a number into a string or nesting one object inside another are all
 * ordinary edits with no spelling as a list of columns. So the document is edited as text and sent
 * as a replacement — see `DbRowEdit.document`.
 *
 * **It is still staged.** Confirming here does not write: it stages the replacement the way typing
 * in a cell stages a change, the card is tinted, the count on Apply goes up, and Apply is what
 * sends it after showing the command. A document editor that saved on OK would be the one control
 * in this panel that writes to a production collection without asking twice.
 *
 * The buffer is the shell dialect, not JSON — `ObjectId("…")`, `ISODate("…")` — which is why the
 * editor is set to `javascript` and validation decorations are off: those constructors are calls,
 * and the JSON tokenizer has nowhere to put them. What is actually valid is decided by the server,
 * which is the only thing that can decide it; the check here is the one a text box can honestly
 * make, that the thing is a single `{…}`.
 */
export function DocumentEditorModal({
  modal,
  onClose,
}: {
  modal: {
    title: string;
    text: string;
    mode: "edit" | "clone";
    onSave: (text: string) => void;
  };
  onClose: () => void;
}) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const [text, setText] = useState(modal.text);

  // Balance, not validity. A truncated `{` is worth catching before it becomes a server error the
  // user has to map back onto a line; anything past that (a missing comma, a bad `$oid`) is the
  // driver's judgement to make, and guessing at it here would mean two parsers disagreeing.
  const complaint = useMemo(() => {
    const trimmed = text.trim();
    if (!trimmed) return t("db.documentEmpty");
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return t("db.documentNotObject");
    return null;
  }, [text, t]);

  return (
    <ApiModal
      icon={Braces}
      title={modal.title}
      subtitle={modal.mode === "clone" ? t("db.cloneDocumentHint") : t("db.editDocumentHint")}
      width="max-w-3xl"
      height="h-[78vh]"
      // It holds unsaved text — the same rule every form dialog here follows.
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center gap-2">
          {complaint && (
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--cf-danger)]">
              <AlertTriangle size={12} className="shrink-0" />
              <span className="truncate">{complaint}</span>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
            <PrimaryButton
              disabled={complaint !== null}
              onClick={() => {
                modal.onSave(text.trim());
                onClose();
              }}
            >
              {modal.mode === "clone" ? t("db.stageInsert") : t("db.stageReplace")}
            </PrimaryButton>
          </div>
        </div>
      }
    >
      {/* `ApiModal`'s body brings no padding or scroll of its own — see the note in
          `ConnectionModal`. Here the editor owns the whole area. */}
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <div className="h-full overflow-hidden rounded-md border border-[var(--cf-border)]">
          <Editor
            height="100%"
            // Its own model, and the `cf-db:` scheme keeps it out of the file models' way.
            path="cf-db:/document-editor.js"
            language="javascript"
            value={text}
            onChange={(value) => setText(value ?? "")}
            theme={monacoTheme}
            options={{
              ...OVERFLOW_SAFE_OPTIONS,
              minimap: { enabled: false },
              fontSize: 12,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              renderValidationDecorations: "off",
              tabSize: 2,
              lineNumbers: "on",
              overviewRulerLanes: 0,
              padding: { top: 8, bottom: 8 },
              scrollbar: {
                verticalScrollbarSize: 8,
                horizontalScrollbarSize: 8,
              },
            }}
          />
        </div>
      </div>
    </ApiModal>
  );
}
