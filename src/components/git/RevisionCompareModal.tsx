import { useEffect, useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { GitCompareArrows } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Select, type SelectOption } from "../common/Select";
import { fileAtRevision, listBranches, readFileText } from "../../lib/tauri/commands";
import { useFileLanguage } from "../../lib/useFileLanguage";
import { useRevisionCompareStore } from "../../state/revisionCompareStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import type { BranchInfo } from "../../types/domain";
import "../../lib/monacoSetup";

/**
 * A file on disk (right) against the same file at a revision (left): `HEAD`, or any local or remote
 * branch picked in the toolbar. Read-only — a comparison to look at; the editor is where to change it.
 */
export function RevisionCompareModal({ repoPath, path, revision }: { repoPath: string; path: string; revision: string | null }) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [sides, setSides] = useState<{ left: string; right: string } | null>(null);
  const [error, setError] = useState("");
  const language = useFileLanguage(path, sides?.right ?? "");

  useEffect(() => {
    void listBranches(repoPath).then(setBranches, () => setBranches([]));
  }, [repoPath]);

  useEffect(() => {
    if (!revision) return;
    let live = true;
    setSides(null);
    setError("");
    void Promise.all([fileAtRevision(repoPath, revision, path), readFileText(repoPath, path).catch(() => "")])
      .then(([left, right]) => live && setSides({ left: left ?? "", right }))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [repoPath, path, revision]);

  const options = useMemo<SelectOption[]>(() => {
    const names = ["HEAD", ...branches.filter((b) => !b.is_head || b.is_remote).map((b) => b.name)];
    return [...new Set(names)].map((name) => ({ value: name, label: name === "HEAD" ? t("compare.head") : name }));
  }, [branches, t]);

  return (
    <ApiModal
      icon={GitCompareArrows}
      title={t("compare.withRevision")}
      subtitle={path}
      width="max-w-6xl"
      height="h-[80vh]"
      onClose={() => useRevisionCompareStore.getState().close()}
      toolbar={
        <div className="w-[220px]">
          <Select
            size="sm"
            value={revision ?? ""}
            placeholder={t("compare.pickRevision")}
            onChange={(value) => useRevisionCompareStore.getState().setRevision(value)}
            options={options}
            ariaLabel={t("compare.pickRevision")}
          />
        </div>
      }
    >
      <div className="min-h-0 flex-1">
        {!revision ? (
          <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("compare.pickRevision")}</p>
        ) : error ? (
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
              originalEditable: false,
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
