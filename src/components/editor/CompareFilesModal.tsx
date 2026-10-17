import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { ArrowLeftRight, GitCompareArrows } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { iconButtonClass } from "../common/Button";
import { readFileText } from "../../lib/tauri/commands";
import { useFileLanguage } from "../../lib/useFileLanguage";
import { useThemeStore } from "../../state/themeStore";
import { useCompareStore } from "../../state/compareStore";
import { useT } from "../../state/languageStore";
import "../../lib/monacoSetup";

/** Two files of the repository side by side, as they are on disk — see `compareStore`. With `buffer`,
 *  one file as saved against its unsaved text (VS Code's «Compare with Saved»). */
export function CompareFilesModal({
  repoPath,
  left,
  right,
  buffer,
  label,
}: {
  repoPath: string;
  left: string;
  right: string;
  buffer?: string;
  /** The subtitle for a `buffer` comparison — the replace preview names itself. */
  label?: string;
}) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const [sides, setSides] = useState<{ left: string; right: string } | null>(null);
  const [error, setError] = useState("");
  const language = useFileLanguage(right, sides?.right ?? "");

  useEffect(() => {
    let live = true;
    setSides(null);
    void Promise.all([readFileText(repoPath, left), buffer !== undefined ? buffer : readFileText(repoPath, right)])
      .then(([a, b]) => live && setSides({ left: a, right: b }))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [repoPath, left, right, buffer]);

  return (
    <ApiModal
      icon={GitCompareArrows}
      title={t("compare.title")}
      subtitle={buffer !== undefined ? (label ?? t("compare.savedSubtitle", { path: left })) : `${left} ↔ ${right}`}
      width="max-w-6xl"
      height="h-[80vh]"
      onClose={() => useCompareStore.getState().close()}
      toolbar={
        buffer !== undefined ? undefined : (
        <button
          type="button"
          onClick={() => useCompareStore.getState().compare(right, left)}
          title={t("compare.swap")}
          aria-label={t("compare.swap")}
          className={iconButtonClass({ size: "sm" })}
        >
          <ArrowLeftRight size={14} />
        </button>
        )
      }
    >
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="p-4 text-[12px] text-[var(--cf-danger)]">{error}</p>
        ) : sides ? (
          <DiffEditor
            height="100%"
            language={language}
            original={sides.left}
            modified={sides.right}
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
        ) : (
          <div className="h-full bg-[var(--cf-sunken)]" />
        )}
      </div>
    </ApiModal>
  );
}
