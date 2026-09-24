import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Globe,
  Layers,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  Wand2,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { buttonClass, iconButtonClass } from "../common/Button";
import { ActiveUnderline } from "../common/ActivePill";
import { Tooltip } from "../common/Tooltip";
import {
  explorerClass,
  fieldClass,
  rowClass,
  sectionLabelClass,
  underlineStripClass,
  underlineTabClass,
} from "../common/recipes";
import { ApiModal } from "./ApiModal";
import { VariableTable } from "./VariableTable";
import { useApiStore } from "../../state/apiStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { exportEnvironment } from "../../lib/api/exporters";
import { importAny } from "../../lib/api/importers";
import { DYNAMIC_VARIABLES } from "../../lib/api/variables";
import { apiPickFile, apiReadTextFile, apiSaveFile } from "../../lib/tauri/apiCommands";
import type { ApiEnvironment, ApiVariable } from "../../types/api";

/** How long an edit sits in the draft before it reaches SQLite. */
const COMMIT_DEBOUNCE_MS = 400;

function parseVariables(json: string | undefined): ApiVariable[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ApiVariable[]) : [];
  } catch {
    return [];
  }
}

/** What a variable is actually worth right now — the same rule `variables.ts` resolves by. */
function effectiveValue(variable: ApiVariable): string {
  return variable.currentValue !== "" ? variable.currentValue : variable.initialValue;
}

/** Globals first, then the rest in their stored order. */
function ordered(environments: ApiEnvironment[]): ApiEnvironment[] {
  return [...environments].sort((a, b) => {
    if (a.is_global !== b.is_global) return a.is_global ? -1 : 1;
    return a.sort_order - b.sort_order;
  });
}

export function EnvironmentModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const environments = useApiStore((s) => s.environments);
  const createEnvironment = useApiStore((s) => s.createEnvironment);
  const duplicateEnvironment = useApiStore((s) => s.duplicateEnvironment);
  const deleteEnvironment = useApiStore((s) => s.deleteEnvironment);
  const pushToast = useToastStore((s) => s.pushToast);

  const [tab, setTab] = useState<"variables" | "dynamic">("variables");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<ApiVariable[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [importing, setImporting] = useState(false);

  const list = ordered(environments);
  const selected = list.find((e) => e.id === selectedId) ?? null;

  /**
   * Variable edits arrive per keystroke but each one rewrites the environment's whole JSON blob
   * through an IPC call, so the table is edited as a local draft and written on a trailing timer.
   * Everything that can lose the draft — switching environments, closing, unmounting — flushes it
   * first rather than hoping the timer wins the race.
   */
  const pendingRef = useRef<{ id: string; rows: ApiVariable[] } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending) return;
    const store = useApiStore.getState();
    const environment = store.environments.find((e) => e.id === pending.id);
    if (!environment) return;
    void store.updateEnvironment({ ...environment, variables: JSON.stringify(pending.rows) });
  }, []);

  useEffect(() => flush, [flush]);

  const commit = useCallback(
    (next: ApiVariable[]) => {
      if (!selectedId) return;
      setRows(next);
      pendingRef.current = { id: selectedId, rows: next };
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, COMMIT_DEBOUNCE_MS);
    },
    [flush, selectedId],
  );

  const select = useCallback(
    (id: string) => {
      if (id === selectedId) return;
      flush();
      setSelectedId(id);
      setRows(parseVariables(useApiStore.getState().environments.find((e) => e.id === id)?.variables));
    },
    [flush, selectedId],
  );

  // Picks the initial selection, and recovers if the selected environment is deleted underneath us.
  useEffect(() => {
    if (selectedId !== null && environments.some((e) => e.id === selectedId)) return;
    const fallback = ordered(environments).find((e) => e.is_global) ?? ordered(environments)[0];
    setSelectedId(fallback?.id ?? null);
    setRows(parseVariables(fallback?.variables));
  }, [environments, selectedId]);

  const createNew = async () => {
    flush();
    const created = await createEnvironment(t("api.env.new"));
    if (!created) return;
    setSelectedId(created.id);
    setRows([]);
    setRenamingId(created.id);
    setRenameValue(created.name);
  };

  const commitRename = (environment: ApiEnvironment) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name || name === environment.name) return;
    void useApiStore.getState().updateEnvironment({ ...environment, name });
  };

  const remove = async (environment: ApiEnvironment) => {
    if (!(await confirmAction(t("api.env.deleteConfirm", { name: environment.name })))) return;
    await deleteEnvironment(environment.id);
  };

  /**
   * Secret values are left out unless they are asked for, and the checkbox that asks only exists
   * when the environment has one — same rule as the collection export. It is worth having at all
   * because this file is the *only* way those values move: what a shared collection carries is the
   * variable's key and nothing else, deliberately, so a teammate filling in their own token has
   * this or retyping.
   */
  const exportOne = async (environment: ApiEnvironment) => {
    flush();
    try {
      // Straight from the store rather than from `rows`: `flush` writes through a debounce and the
      // draft above is only the environment currently selected.
      const fresh =
        useApiStore.getState().environments.find((e) => e.id === environment.id) ?? environment;
      const json = exportEnvironment(fresh, { includeSecrets });
      const path = await apiSaveFile(`${fresh.name || "environment"}.postman_environment.json`, json);
      if (path) pushToast(t("api.export.done", { path }), "success");
    } catch (e) {
      pushErrorToast(t("api.toast.exportFailed", { error: String(e) }));
    }
  };

  /**
   * The other half of it, reading whatever `importAny` recognises — Postman environments and
   * Globals, Insomnia exports, a CodeFlow file — and taking only the environments out of it. A
   * file that also carries collections is not silently half-applied: that is the import screen's
   * job, and it says so rather than dropping them on the floor.
   */
  const importFile = async () => {
    flush();
    const path = await apiPickFile(["json", "yaml", "yml"]).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (!path) return;

    setImporting(true);
    try {
      const result = await importAny(await apiReadTextFile(path));
      if (result.environments.length === 0) {
        pushErrorToast(t("api.env.importNothing"));
        return;
      }

      const store = useApiStore.getState();
      let last: string | null = null;
      for (const environment of result.environments) {
        const created = await store.createEnvironment(environment.name);
        if (!created) continue;
        await store.updateEnvironment({
          ...created,
          variables: JSON.stringify(environment.variables),
        });
        last = created.id;
      }

      // Landed on, not just added to a list — an import nobody can see is indistinguishable from
      // one that failed.
      if (last) select(last);
      pushToast(
        t("api.env.imported", { n: String(result.environments.length) }),
        result.collections.length > 0 ? "info" : "success",
      );
      if (result.collections.length > 0) pushToast(t("api.env.importOnlyEnvs"), "info");
    } catch (e) {
      pushErrorToast(t("api.import.failed", { error: String(e) }));
    } finally {
      setImporting(false);
    }
  };

  const resetToInitial = () => commit(rows.map((row) => ({ ...row, currentValue: "" })));

  const persistCurrent = () =>
    commit(rows.map((row) => ({ ...row, initialValue: effectiveValue(row) })));

  const copyToken = (name: string) => {
    void navigator.clipboard.writeText(`{{${name}}}`);
    setCopied(name);
    window.setTimeout(() => setCopied((current) => (current === name ? null : current)), 1200);
  };

  return (
    <ApiModal
      icon={Layers}
      title={t("api.env.manage")}
      width="max-w-5xl"
      height="h-[80vh]"
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-1">
        {/* Environment list — the explorer of this dialog, half a step into the sunken tone so the
            sheet beside it reads as the page. */}
        <div className={`${explorerClass} w-[200px]`}>
          <div className="shrink-0 px-2">
            <div className={sectionLabelClass}>
              <span className="min-w-0 flex-1 truncate">{t("api.environments")}</span>
              <Tooltip label={t("api.env.import")}>
                <button
                  type="button"
                  onClick={() => void importFile()}
                  disabled={importing}
                  aria-label={t("api.env.import")}
                  className={iconButtonClass({ size: "xs" })}
                >
                  {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                </button>
              </Tooltip>
              <Tooltip label={t("api.env.new")}>
                <button
                  type="button"
                  onClick={() => void createNew()}
                  aria-label={t("api.env.new")}
                  className={iconButtonClass({ size: "xs" })}
                >
                  <Plus size={14} />
                </button>
              </Tooltip>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-2 pb-2">
            {list.length === 0 && (
              <p className="px-2 py-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("api.env.noEnvironments")}</p>
            )}
            {list.map((environment) => {
              const active = environment.id === selectedId;
              const EnvIcon = environment.is_global ? Globe : Layers;
              return (
                <div
                  key={environment.id}
                  onClick={() => select(environment.id)}
                  onDoubleClick={() => {
                    if (environment.is_global) return;
                    setRenamingId(environment.id);
                    setRenameValue(environment.name);
                  }}
                  className={rowClass(active, "group h-7 shrink-0 cursor-pointer")}
                >
                  <EnvIcon
                    size={14}
                    className={`shrink-0 ${active ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-faint)]"}`}
                  />
                  {renamingId === environment.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => commitRename(environment)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(environment);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={t("api.env.name")}
                      className={fieldClass({ size: "sm", className: "flex-1" })}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">
                      {environment.is_global ? t("api.env.globals") : environment.name}
                    </span>
                  )}
                  {/* Export used to live here too, as a hover-only icon that stripped secrets with
                      no way to say otherwise. One export, in the toolbar, acting on the environment
                      on screen — the same place Reset and Persist already act from. */}
                  <span className="flex shrink-0 items-center opacity-0 focus-within:opacity-100 group-hover:opacity-100">
                    {!environment.is_global && (
                      <>
                        <Tooltip label={t("api.duplicate")}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void duplicateEnvironment(environment.id);
                            }}
                            aria-label={t("api.duplicate")}
                            className={iconButtonClass({ size: "xs" })}
                          >
                            <Copy size={13} />
                          </button>
                        </Tooltip>
                        <Tooltip label={t("api.delete")}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void remove(environment);
                            }}
                            aria-label={t("api.delete")}
                            className={iconButtonClass({ size: "xs" })}
                          >
                            <Trash2 size={13} />
                          </button>
                        </Tooltip>
                      </>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Detail */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The section tabs, and beside them — outside the tab list, on the same hairline — the
              actions that belong to the variables of the environment on screen. */}
          <div className="flex shrink-0 items-stretch">
            <div role="tablist" className={`${underlineStripClass} grow`}>
              {(
                [
                  ["variables", t("api.tab.variables")],
                  ["dynamic", t("api.env.dynamicVariables")],
                ] as const
              ).map(([id, label]) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(id)}
                    className={underlineTabClass(active)}
                  >
                    {label}
                    {active && <ActiveUnderline layoutId="cf-api-env-tab" />}
                  </button>
                );
              })}
            </div>

            {tab === "variables" && selected && (
              <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] pr-3">
                <button type="button" onClick={resetToInitial} className={buttonClass({ variant: "ghost", size: "sm" })}>
                  <RotateCcw size={13} />
                  {t("api.env.reset")}
                </button>
                <button type="button" onClick={persistCurrent} className={buttonClass({ variant: "ghost", size: "sm" })}>
                  <Save size={13} />
                  {t("api.env.persist")}
                </button>
                {/* Only where it can mean something: an environment with no secret variable has
                    nothing to hold back, and a permanently visible "include secrets" next to an
                    export is how a warning stops being read. */}
                {rows.some((row) => row.secret) && (
                  <Tooltip label={t("api.export.secretsWarning")}>
                    <label className="ml-1 flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                      <Checkbox checked={includeSecrets} onChange={setIncludeSecrets} />
                      {t("api.env.exportSecrets")}
                    </label>
                  </Tooltip>
                )}
                <Tooltip label={t("api.export.environment")}>
                  <button
                    type="button"
                    onClick={() => void exportOne(selected)}
                    className={buttonClass({ variant: "ghost", size: "sm" })}
                  >
                    <Download size={13} />
                    {t("api.export.title")}
                  </button>
                </Tooltip>
              </div>
            )}
          </div>

          {tab === "dynamic" ? (
            <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">
              <p className="mb-2.5 flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                <Wand2 size={13} className="shrink-0" />
                {t("api.env.dynamicHint")}
              </p>
              <div className="overflow-hidden rounded-md border border-[var(--cf-border)]">
                {DYNAMIC_VARIABLES.map((variable, index) => (
                  <button
                    key={variable.name}
                    type="button"
                    onClick={() => copyToken(variable.name)}
                    title={t("api.snippet.copy")}
                    className={`flex h-8 w-full items-center gap-3 px-2.5 text-left transition-colors duration-100 hover:bg-[var(--cf-hover)] ${
                      index === 0 ? "" : "border-t border-[var(--cf-border)]"
                    }`}
                  >
                    <span className="w-[190px] shrink-0 truncate font-mono text-[12px] text-[var(--cf-accent)]">
                      {`{{${variable.name}}}`}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                      {variable.description}
                    </span>
                    <span
                      className="w-[220px] shrink-0 truncate font-mono text-[12px] text-[var(--cf-text-muted)]"
                      title={variable.example}
                    >
                      {variable.example}
                    </span>
                    <span className="w-[72px] shrink-0 text-right text-[11px] text-[var(--cf-text-faint)]">
                      {copied === variable.name ? (
                        <span className="inline-flex items-center gap-1 text-[var(--cf-success)]">
                          <Check size={13} />
                          {t("api.snippet.copied")}
                        </span>
                      ) : (
                        <Copy size={13} className="ml-auto inline" />
                      )}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : !selected ? (
            <div className="flex flex-1 items-center justify-center p-6 text-[12px] text-[var(--cf-text-muted)]">
              {t("api.env.noEnvironments")}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-3.5 py-3">
              {selected.is_global && (
                <p className="mb-2.5 text-[12px] text-[var(--cf-text-muted)]">{t("api.env.globalsHint")}</p>
              )}

              {/* Keyed by environment so switching brings the new list up with its secrets masked
                  rather than inheriting whatever the previous one had revealed. */}
              <VariableTable
                key={selected.id}
                rows={rows}
                onChange={commit}
                emptyLabel={t("api.env.noVariables")}
              />
            </div>
          )}
        </div>
      </div>
    </ApiModal>
  );
}
