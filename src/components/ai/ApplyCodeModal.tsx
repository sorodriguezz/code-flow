import { useEffect, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { FileDiff, FilePlus2 } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Button } from "../common/Button";
import { createFile, readFileText, writeFileText } from "../../lib/tauri/commands";
import { useFileLanguage } from "../../lib/useFileLanguage";
import { useApplyCodeStore, type ApplyCodeRequest } from "../../lib/codeToEditor";
import { useThemeStore } from "../../state/themeStore";
import { useUiStore } from "../../state/uiStore";
import { pushErrorToast } from "../../state/toastStore";
import { recordExperience } from "../../lib/tauri/experiencesCommands";
import { useT } from "../../state/languageStore";
import "../../lib/monacoSetup";

/** How long after the last keystroke in the path field the file is read again. */
const READ_DELAY_MS = 250;

/**
 * «Aplicar al archivo»: a code block of the repository chat against the file it is meant for, as a
 * diff — the file as it is on the left, the block on the right, editable, since a block is often
 * only part of a file and the user finishes the merge here. «Aplicar» writes the right side and opens
 * the file; a path that names no file yet creates it.
 */
export function ApplyCodeModal({ request, repoPath }: { request: ApplyCodeRequest; repoPath: string }) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const [path, setPath] = useState(request.path);
  /** The file as it is: `null` while reading, `""` with `missing` for a path that names none. */
  const [current, setCurrent] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const modifiedRef = useRef<() => string>(() => request.code);
  /** The left side last read — kept on screen while the next path is read, so the diff stays
   *  mounted and the edits made on the right are not lost to a re-mount. */
  const [original, setOriginal] = useState<string | null>(null);
  useEffect(() => {
    if (current !== null) setOriginal(current);
  }, [current]);
  const language = useFileLanguage(path || null, request.code);
  const target = path.trim().replace(/^\.?\//, "");
  const valid = target !== "" && !target.split(/[\\/]/).some((part) => part === ".." || part === "");

  useEffect(() => {
    if (!valid) {
      setCurrent("");
      setMissing(true);
      return;
    }
    let live = true;
    setCurrent(null);
    const timer = window.setTimeout(() => {
      readFileText(repoPath, target)
        .then((text) => {
          if (!live) return;
          setCurrent(text);
          setMissing(false);
        })
        .catch(() => {
          if (!live) return;
          setCurrent("");
          setMissing(true);
        });
    }, READ_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [repoPath, target, valid]);

  const onMount: DiffOnMount = (editor) => {
    const modified = editor.getModifiedEditor();
    modifiedRef.current = () => modified.getValue();
  };

  const close = () => useApplyCodeStore.getState().close();
  const apply = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      if (missing) await createFile(repoPath, target);
      const applied = modifiedRef.current();
      await writeFileText(repoPath, target, applied);
      // Code from an answer, applied as reviewed: an accepted solution (`crate::experiences`).
      recordExperience({
        source: "apply_code",
        signal: "accepted",
        repoPath,
        response: applied,
        detail: { path: target, created: missing },
      });
      useUiStore.getState().openInEditor(target);
      close();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={FileDiff}
      title={t("chat.applyCodeTitle")}
      width="max-w-6xl"
      height="h-[80vh]"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={close}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]">
            {missing && valid ? t("chat.applyCodeNewFile") : t("chat.applyCodeHint")}
          </span>
          <Button variant="secondary" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void apply()} disabled={!valid || busy || current === null}>
            {missing && <FilePlus2 size={13} />}
            {missing ? t("chat.applyCodeCreate") : t("chat.applyCodeApply")}
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <label htmlFor="cf-apply-path" className="shrink-0 text-[12px] text-[var(--cf-text-muted)]">
            {t("chat.applyCodeFile")}
          </label>
          <input
            id="cf-apply-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="src/…"
            spellCheck={false}
            autoFocus={!request.path}
            className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
          />
        </div>
        <div className="min-h-0 flex-1">
          {original === null ? (
            <div className="h-full bg-[var(--cf-sunken)]" />
          ) : (
            <DiffEditor
              height="100%"
              language={language}
              original={original}
              modified={request.code}
              theme={monacoTheme}
              onMount={onMount}
              options={{
                readOnly: false,
                originalEditable: false,
                fontSize: 12.5,
                renderSideBySide: true,
                useInlineViewWhenSpaceIsLimited: false,
                automaticLayout: true,
                maxComputationTime: 2000,
                scrollBeyondLastLine: false,
              }}
            />
          )}
        </div>
      </div>
    </ApiModal>
  );
}
