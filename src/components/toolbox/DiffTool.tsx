/**
 * Text diff on Monaco's diff editor — both sides editable, side by side or inline. Its own module
 * so Monaco loads only when this tool is opened.
 */
import { useRef } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import "../../lib/monacoSetup";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import { Labeled, OptionsRow, paneClass } from "./kit";
import { CheckLabel } from "./EncodeTools";

const LANGUAGES = ["plaintext", "json", "yaml", "xml", "javascript", "typescript", "sql", "markdown", "csharp", "java", "python", "rust", "go", "html", "css", "shell"];

export default function DiffTool() {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const [left, setLeft] = useToolField("diff", "left", "");
  const [right, setRight] = useToolField("diff", "right", "");
  const [inline, setInline] = useToolField<"split" | "inline">("diff", "layout", "split");
  const [ignoreWs, setIgnoreWs] = useToolField("diff", "ignoreWs", false);
  const [language, setLanguage] = useToolField("diff", "language", "plaintext");
  // The editor's own models are the source of truth while it is mounted; the store keeps a copy
  // so switching tools and back finds the text again.
  const setters = useRef({ setLeft, setRight });
  setters.current = { setLeft, setRight };
  const onMount: DiffOnMount = (editor) => {
    const original = editor.getOriginalEditor();
    const modified = editor.getModifiedEditor();
    original.onDidChangeModelContent(() => setters.current.setLeft(original.getValue()));
    modified.onDidChangeModelContent(() => setters.current.setRight(modified.getValue()));
  };
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-diff-layout"
          size="sm"
          value={inline}
          onChange={setInline}
          options={[
            { value: "split", label: t("toolbox.diff.split") },
            { value: "inline", label: t("toolbox.diff.inline") },
          ]}
        />
        <CheckLabel checked={ignoreWs} onChange={setIgnoreWs} label={t("toolbox.diff.ignoreWs")} />
        <Labeled label={t("toolbox.code.language")}>
          <Select size="compact" value={language} onChange={setLanguage} options={LANGUAGES.map((l) => ({ value: l, label: l }))} />
        </Labeled>
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">{t("toolbox.diff.hint")}</span>
      </OptionsRow>
      <div className={`${paneClass} flex-1`}>
        <DiffEditor
          height="100%"
          language={language}
          original={left}
          modified={right}
          theme={monacoTheme}
          onMount={onMount}
          options={{
            originalEditable: true,
            renderSideBySide: inline === "split",
            useInlineViewWhenSpaceIsLimited: false,
            ignoreTrimWhitespace: ignoreWs,
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 12.5,
            scrollBeyondLastLine: false,
            maxComputationTime: 5000,
          }}
        />
      </div>
    </>
  );
}
