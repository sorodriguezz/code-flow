import { useRef } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Play, Square, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";
import type { DbStatementResult } from "../../types/database";

/**
 * The SQL console — a drawer under the grid, with no production guards, on purpose.
 *
 * `sqlGuards.unguardedDelete` and the rest of that family exist because the *Base de datos*
 * workspace's console points at real connections, where `DELETE FROM usuarios` with no `WHERE` is
 * a career event. Here it is a thing you write every day: the database is a scratch file for one
 * diagram, wiping it is a button three inches away, and refusing the statement would be refusing
 * the feature. So there is no confirmation, no implicit `LIMIT`, and nothing rewrites your text.
 *
 * What there is: a row cap with a truncation chip, a Stop button (backed by SQLite's progress
 * handler, which is the only thing that can interrupt a running statement), and an unconditional
 * refresh of the grid after every run — because your `UPDATE` could have touched anything, and a
 * grid still showing the rows from before it would be lying.
 *
 * # It fills the height it is given
 *
 * The editor used to be 104px and the results `max-h-44`, both fixed, so on a 13" screen a query
 * of five lines scrolled inside a box a third of its size and the rows it returned arrived in a
 * 176px slot underneath. Nothing here sets its own height any more: the pane is dragged to the size
 * you want (see `dbmlConsoleHeight`), the editor takes a third of it and the results take the rest.
 */

export function SandboxConsole({
  sql,
  onChange,
  onRun,
  onCancel,
  onClose,
  running,
  results,
}: {
  sql: string;
  onChange: (sql: string) => void;
  /** Runs `selected` when there is a selection, the whole buffer otherwise. */
  onRun: (sql: string) => void;
  onCancel: () => void;
  /** Shuts the pane. Here as well as in the toolbar because this is where you are looking. */
  onClose: () => void;
  running: boolean;
  results: DbStatementResult[] | null;
}) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  /** What ⌘↵ runs: the selection if there is one, otherwise everything. */
  const target = () => {
    const instance = editorRef.current;
    if (!instance) return sql;
    const selection = instance.getSelection();
    const picked = selection ? instance.getModel()?.getValueInRange(selection) : "";
    return picked && picked.trim() ? picked : instance.getValue();
  };

  const mount = (instance: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = instance;
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRun(target()));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text)]">
          {t("dbml.sandbox.console")}
        </span>
        {/* The chord, written down. It is the difference between a console you use with two hands
            on the keyboard and one you drive by aiming at a button. */}
        <span className="hidden font-mono text-[10px] text-[var(--cf-text-muted)] sm:inline">
          {t("dbml.sandbox.consoleRunHint")}
        </span>
        <span className="flex-1" />
        {running ? (
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-[var(--cf-danger)]/50 px-2.5 text-[11px] font-medium text-[var(--cf-danger)] transition-colors hover:bg-[var(--cf-danger)]/10"
          >
            <Square size={11} />
            {t("dbml.sandbox.stop")}
          </button>
        ) : (
          // The primary verb of this pane, and filled like one. It was a hairline-bordered muted
          // chip, which on a dark strip is the same weight as the labels around it.
          <button
            type="button"
            onClick={() => onRun(target())}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
          >
            <Play size={11} />
            {t("dbml.sandbox.run")}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title={t("dbml.sandbox.consoleClose")}
          aria-label={t("dbml.sandbox.consoleClose")}
          className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          <X size={14} />
        </button>
      </div>

      {/* A third of the pane for the query and the rest for the answer — both in `flex`, so
          dragging the pane taller makes the query taller *and* shows more rows. */}
      <div className="min-h-[64px] flex-[1] border-b border-[var(--cf-border)]">
        <Editor
          language="sql"
          theme={monacoTheme}
          value={sql}
          onChange={(next) => onChange(next ?? "")}
          onMount={mount}
          options={{
            minimap: { enabled: false },
            lineNumbers: "off",
            fontSize: 12,
            scrollBeyondLastLine: false,
            folding: false,
            renderLineHighlight: "none",
            overviewRulerLanes: 0,
            automaticLayout: true,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            padding: { top: 6, bottom: 6 },
          }}
        />
      </div>

      <div className="min-h-0 flex-[2] overflow-auto">
        {results === null || results.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-[var(--cf-text-muted)]">
            {t("dbml.sandbox.consoleEmpty")}
          </p>
        ) : (
          results.map((result, index) => <ResultBlock key={index} result={result} />)
        )}
      </div>
    </div>
  );
}

function ResultBlock({ result }: { result: DbStatementResult }) {
  const t = useT();
  if (result.error) {
    return (
      <div className="border-b border-[var(--cf-border)] px-2 py-1.5 font-mono text-[11px] text-[var(--cf-danger)]">
        {result.error}
      </div>
    );
  }
  if (result.columns.length === 0) {
    return (
      <div className="border-b border-[var(--cf-border)] px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
        {t("dbml.sandbox.affected", {
          count: String(result.rows_affected ?? 0),
          ms: String(result.duration_ms),
        })}
      </div>
    );
  }
  return (
    <div className="border-b border-[var(--cf-border)]">
      <div className="px-2 py-1 text-[10.5px] text-[var(--cf-text-muted)]">
        {t("dbml.sandbox.returned", {
          count: String(result.rows.length),
          ms: String(result.duration_ms),
        })}
        {result.truncated && (
          <span className="ml-1.5 rounded bg-[var(--cf-warning)]/15 px-1 text-[var(--cf-warning)]">
            {t("dbml.sandbox.truncated")}
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="border-collapse text-[11.5px]">
          <thead>
            <tr>
              {result.columns.map((column) => (
                <th
                  key={column.name}
                  className="sticky top-0 z-10 whitespace-nowrap border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-[5px] text-left font-medium text-[var(--cf-text-muted)]"
                >
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              <tr key={index} className="hover:bg-[var(--cf-hover)]">
                {row.map((value, at) => (
                  <td
                    key={at}
                    className="max-w-[280px] truncate border-b border-r border-[var(--cf-border)] px-2 py-[4px] font-mono"
                  >
                    {value === null ? (
                      <span className="text-[var(--cf-text-muted)] opacity-60">NULL</span>
                    ) : (
                      value
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
