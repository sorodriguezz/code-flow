import { useEffect } from "react";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { Copy, FileCode2, Loader2, Pencil, RefreshCw } from "lucide-react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { ToolbarButton } from "./dbChrome";
import { nodeLabel } from "./SqlConsolePanel";
import { useDbStore, type DbDdlTab } from "../../state/dbStore";
import { useDbCommandStore } from "../../state/dbCommandStore";
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
  /** Mongo's definition is JSON; Redis's is a block of `#`-commented commands, which `shell`
   *  tokenises correctly and `json` would paint as one long error. */
  const definitionLanguage = isSql
    ? "sql"
    : connection && engineInfo(connection.kind).consoleLanguage === "redis"
      ? "shell"
      : "json";

  /**
   * Whether this definition is a statement you can run to change the object.
   *
   * Only where the DDL above is the server's own `CREATE OR REPLACE` — a routine's and a view's.
   * Running those again is how you redefine them, so handing the text to a console is a real edit
   * path and not a trick. A table's is reconstructed and lossy, and a sequence's `CREATE SEQUENCE`
   * names one that already exists; offering "edit" on either would produce a statement that fails
   * at best and drops a check constraint nobody noticed at worst. Those still change through SQL
   * you write, which is the honest amount of ceremony for an `ALTER`.
   */
  const replaceable = isSql && (tab.node.kind === "routine" || tab.node.kind === "view");

  // Refresh is the only one of the workspace's commands this panel has an answer for; the rest
  // belong to a grid. It still consumes every request, so none is left pending for the next tab.
  const request = useDbCommandStore((s) => s.request);
  useEffect(() => {
    if (!request) return;
    useDbCommandStore.getState().consume();
    if (request.command === "refresh") void store.openDdl(tab.connectionId, tab.node, tab.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

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
          {replaceable && (
            <ToolbarButton
              onClick={() =>
                store.newConsole(
                  tab.connectionId,
                  tab.node.database ?? undefined,
                  tab.node.schema ?? undefined,
                  tab.text,
                )
              }
              disabled={!tab.text}
              title={t("db.editDefinition")}
            >
              <Pencil size={12} />
            </ToolbarButton>
          )}
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
            path={`cf-db:/ddl/${tab.id}.${definitionLanguage}`}
            language={definitionLanguage}
            value={tab.text}
            theme={monacoTheme}
            options={OPTIONS}
          />
        )}
      </div>
    </div>
  );
}
