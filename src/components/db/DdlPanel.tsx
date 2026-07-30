import Editor from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { Copy, FileCode2, Loader2, RefreshCw } from "lucide-react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { ToolbarButton } from "./dbChrome";
import { nodeLabel } from "./SqlConsolePanel";
import { useDbStore, type DbDdlTab } from "../../state/dbStore";
import { useThemeStore } from "../../state/themeStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { engineInfo } from "../../types/database";

const OPTIONS: MonacoEditorNS.IStandaloneEditorConstructionOptions = {
  ...OVERFLOW_SAFE_OPTIONS,
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 12.5,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  renderLineHighlight: "none",
  overviewRulerLanes: 0,
  padding: { top: 8, bottom: 8 },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
};

/**
 * An object's definition.
 *
 * Read-only, and honest about what it is: for a view or a routine this is the text the server kept,
 * but for a table it is *reconstructed* from what introspection saw — columns, types, nullability and
 * the primary key. That is not always byte-identical to the original `CREATE TABLE` (a check
 * constraint or a storage clause can be missing), and the header says so rather than letting it look
 * like a faithful dump. For IRIS it goes further: a table there is a projection of a class, so the
 * class name is the first line.
 */
export function DdlPanel({ tab }: { tab: DbDdlTab }) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const connection = useDbStore((s) => s.connections.find((c) => c.id === tab.connectionId));
  const store = useDbStore.getState();
  const isSql = connection ? engineInfo(connection.kind).sql : true;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
        <FileCode2 size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="max-w-[300px] truncate text-[12px] font-medium text-[var(--cf-text)]">
          {nodeLabel(tab.node)}
        </span>
        <span className="truncate text-[11px] text-[var(--cf-text-muted)]">
          {t("db.ddlReconstructed")}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ToolbarButton
            onClick={() => {
              void navigator.clipboard.writeText(tab.text);
              useToastStore.getState().pushToast(t("db.copied"), "success");
            }}
            disabled={!tab.text}
            title={t("db.copy")}
          >
            <Copy size={12} />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => void store.openDdl(tab.connectionId, tab.node, tab.name)}
            title={t("db.refresh")}
          >
            <RefreshCw size={12} />
          </ToolbarButton>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab.loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
            <Loader2 size={13} className="animate-spin" />
            {t("db.loading")}
          </div>
        ) : (
          <Editor
            height="100%"
            path={`cf-db:/ddl/${tab.id}.${isSql ? "sql" : "js"}`}
            language={isSql ? "sql" : "json"}
            value={tab.text}
            theme={monacoTheme}
            options={OPTIONS}
          />
        )}
      </div>
    </div>
  );
}
