import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { History, RotateCcw } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Button } from "../common/Button";
import { EmptyState } from "../common/EmptyState";
import { Skeleton } from "../common/Skeleton";
import { localHistoryList, localHistoryRead, type LocalVersion } from "../../lib/tauri/commands";
import { useFileLanguage } from "../../lib/useFileLanguage";
import { useThemeStore } from "../../state/themeStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import "../../lib/monacoSetup";

/**
 * The editor's local history of one file (`local_history.rs`): a version per save, newest first, each
 * compared with the buffer as it is now. «Restaurar» puts the version into the buffer as one edit —
 * undoable with ⌘Z, and saved only when the user saves.
 */
export function LocalHistoryModal({
  repoPath,
  path,
  current,
  onRestore,
  onClose,
}: {
  repoPath: string;
  path: string;
  /** The buffer's text right now — what each version is compared against. */
  current: string;
  onRestore: (text: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLanguageStore((s) => s.language) === "es" ? "es-ES" : "en-US";
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const language = useFileLanguage(path, current);
  const [versions, setVersions] = useState<LocalVersion[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void localHistoryList(repoPath, path)
      .then((rows) => {
        if (!live) return;
        setVersions(rows);
        setPicked(rows[0]?.id ?? null);
      })
      .catch(() => live && setVersions([]));
    return () => {
      live = false;
    };
  }, [repoPath, path]);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    setText(null);
    void localHistoryRead(repoPath, path, picked)
      .then((body) => live && setText(body))
      .catch(() => live && setText(""));
    return () => {
      live = false;
    };
  }, [repoPath, path, picked]);

  const when = (ms: number) =>
    new Date(ms).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <ApiModal
      icon={History}
      title={t("localHistory.title")}
      subtitle={path}
      width="max-w-6xl"
      height="h-[80vh]"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]">{t("localHistory.hint")}</span>
          <Button
            variant="primary"
            size="sm"
            disabled={text === null || !picked}
            onClick={() => {
              if (text === null) return;
              onRestore(text);
              onClose();
            }}
          >
            <RotateCcw size={13} />
            {t("localHistory.restore")}
          </Button>
        </div>
      }
    >
      {versions === null ? (
        <div className="space-y-1.5 p-3" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : versions.length === 0 ? (
        <EmptyState icon={History} title={t("localHistory.empty")} subtitle={t("localHistory.emptyHint")} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="w-[190px] shrink-0 overflow-y-auto border-r border-[var(--cf-border)] p-1.5">
            {versions.map((version, i) => (
              <button
                key={version.id}
                type="button"
                onClick={() => setPicked(version.id)}
                className={`flex w-full flex-col rounded-md px-2 py-1.5 text-left ${
                  picked === version.id ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
                }`}
              >
                <span className="text-[12px] tabular-nums text-[var(--cf-text)]">{when(version.savedAt)}</span>
                <span className="text-[10.5px] text-[var(--cf-text-faint)]">
                  {i === 0 ? t("localHistory.latest") : t("localHistory.bytes", { size: Math.max(1, Math.round(version.bytes / 1024)) })}
                </span>
              </button>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            {text === null ? (
              <div className="h-full bg-[var(--cf-sunken)]" />
            ) : (
              <DiffEditor
                height="100%"
                language={language}
                original={text}
                modified={current}
                theme={monacoTheme}
                options={{
                  readOnly: true,
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
      )}
    </ApiModal>
  );
}
