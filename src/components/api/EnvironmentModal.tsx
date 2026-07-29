import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Globe,
  Layers,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { ApiModal, Field, GhostButton } from "./ApiModal";
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

const GRID = "24px minmax(0,1fr) 96px minmax(0,1.3fr) minmax(0,1.3fr) minmax(0,1fr) 46px";

function parseVariables(json: string | undefined): ApiVariable[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ApiVariable[]) : [];
  } catch {
    return [];
  }
}

function newVariableId(): string {
  return `var-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
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
      setRevealed(new Set());
    },
    [flush, selectedId],
  );

  // Picks the initial selection, and recovers if the selected environment is deleted underneath us.
  useEffect(() => {
    if (selectedId !== null && environments.some((e) => e.id === selectedId)) return;
    const fallback = ordered(environments).find((e) => e.is_global) ?? ordered(environments)[0];
    setSelectedId(fallback?.id ?? null);
    setRows(parseVariables(fallback?.variables));
    setRevealed(new Set());
  }, [environments, selectedId]);

  const updateRow = (id: string, patch: Partial<ApiVariable>) =>
    commit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const addRow = () =>
    commit([
      ...rows,
      {
        id: newVariableId(),
        key: "",
        initialValue: "",
        currentValue: "",
        secret: false,
        enabled: true,
        description: "",
      },
    ]);

  const toggleReveal = (id: string) =>
    setRevealed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
      const result = importAny(await apiReadTextFile(path));
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
        {/* Environment list */}
        <div className="flex w-[200px] shrink-0 flex-col border-r border-[var(--cf-border)]">
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1.5">
            <span className="mr-auto text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("api.environments")}
            </span>
            <button
              onClick={() => void importFile()}
              disabled={importing}
              title={t("api.env.import")}
              className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-50 dark:hover:bg-white/[0.08]"
            >
              <Upload size={13} />
            </button>
            <button
              onClick={() => void createNew()}
              title={t("api.env.new")}
              className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
            >
              <Plus size={13} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-1">
            {list.length === 0 && (
              <p className="p-3 text-[12px] text-[var(--cf-text-muted)]">{t("api.env.noEnvironments")}</p>
            )}
            {list.map((environment) => {
              const active = environment.id === selectedId;
              return (
                <div
                  key={environment.id}
                  onClick={() => select(environment.id)}
                  onDoubleClick={() => {
                    if (environment.is_global) return;
                    setRenamingId(environment.id);
                    setRenameValue(environment.name);
                  }}
                  className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] ${
                    active
                      ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                      : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                  }`}
                >
                  <Globe size={12} className="shrink-0 opacity-70" />
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
                      className="min-w-0 flex-1 rounded border border-[var(--cf-accent)] bg-[var(--cf-surface)] px-1 py-0.5 text-[12px] outline-none"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">
                      {environment.is_global ? t("api.env.globals") : environment.name}
                    </span>
                  )}
                  {/* Export used to live here too, as a hover-only icon that stripped secrets with
                      no way to say otherwise. One export, in the toolbar, acting on the environment
                      on screen — the same place Reset and Persist already act from. */}
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                    {!environment.is_global && (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void duplicateEnvironment(environment.id);
                          }}
                          title={t("api.duplicate")}
                          className="rounded p-0.5 hover:text-[var(--cf-accent)]"
                        >
                          <Copy size={11} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void remove(environment);
                          }}
                          title={t("api.delete")}
                          className="rounded p-0.5 hover:text-[var(--cf-danger)]"
                        >
                          <Trash2 size={11} />
                        </button>
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
          <div className="flex shrink-0 items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1">
            {(
              [
                ["variables", t("api.tab.variables")],
                ["dynamic", t("api.env.dynamicVariables")],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`rounded-md px-2.5 py-1 text-[12px] ${
                  tab === id
                    ? "bg-[var(--cf-accent-soft)] font-medium text-[var(--cf-accent)]"
                    : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                }`}
              >
                {label}
              </button>
            ))}

            {tab === "variables" && selected && (
              <div className="ml-auto flex items-center gap-1">
                <GhostButton onClick={resetToInitial} title={t("api.env.reset")}>
                  <RotateCcw size={12} />
                  {t("api.env.reset")}
                </GhostButton>
                <GhostButton onClick={persistCurrent} title={t("api.env.persist")}>
                  <Save size={12} />
                  {t("api.env.persist")}
                </GhostButton>
                {/* Only where it can mean something: an environment with no secret variable has
                    nothing to hold back, and a permanently visible "include secrets" next to an
                    export is how a warning stops being read. */}
                {rows.some((row) => row.secret) && (
                  <label
                    title={t("api.export.secretsWarning")}
                    className="ml-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]"
                  >
                    <Checkbox checked={includeSecrets} onChange={setIncludeSecrets} />
                    {t("api.env.exportSecrets")}
                  </label>
                )}
                <GhostButton onClick={() => void exportOne(selected)} title={t("api.export.environment")}>
                  <Download size={12} />
                  {t("api.export.title")}
                </GhostButton>
              </div>
            )}
          </div>

          {tab === "dynamic" ? (
            <div className="min-h-0 flex-1 overflow-auto p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
                <Wand2 size={12} />
                {t("api.env.dynamicHint")}
              </p>
              <div className="overflow-hidden rounded-md border border-[var(--cf-border)]">
                {DYNAMIC_VARIABLES.map((variable, index) => (
                  <button
                    key={variable.name}
                    onClick={() => copyToken(variable.name)}
                    title={t("api.snippet.copy")}
                    className={`flex w-full items-center gap-3 px-2.5 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
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
                      className="w-[220px] shrink-0 truncate font-mono text-[11px] text-[var(--cf-text-muted)]"
                      title={variable.example}
                    >
                      {variable.example}
                    </span>
                    <span className="w-[64px] shrink-0 text-right text-[11px] text-[var(--cf-text-muted)]">
                      {copied === variable.name ? (
                        <span className="inline-flex items-center gap-1 text-[var(--cf-success)]">
                          <Check size={11} />
                          {t("api.snippet.copied")}
                        </span>
                      ) : (
                        <Copy size={11} className="ml-auto inline" />
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
            <div className="min-h-0 flex-1 overflow-auto p-3">
              {selected.is_global && (
                <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("api.env.globalsHint")}</p>
              )}

              <div
                className="grid items-center gap-2 border-b border-[var(--cf-border)] pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]"
                style={{ gridTemplateColumns: GRID }}
              >
                <span />
                <span>{t("api.env.variable")}</span>
                <span>{t("api.env.type")}</span>
                <span>{t("api.env.initialValue")}</span>
                <span>{t("api.env.currentValue")}</span>
                <span>{t("api.description")}</span>
                <span />
              </div>

              {rows.length === 0 && (
                <p className="py-4 text-[12px] text-[var(--cf-text-muted)]">{t("api.env.noVariables")}</p>
              )}

              {rows.map((row) => {
                const masked = row.secret && !revealed.has(row.id);
                return (
                  <div
                    key={row.id}
                    className="grid items-center gap-2 border-b border-[var(--cf-border)] py-1"
                    style={{ gridTemplateColumns: GRID }}
                  >
                    <Checkbox
                      checked={row.enabled}
                      onChange={(enabled) => updateRow(row.id, { enabled })}
                    />
                    <Field
                      mono
                      value={row.key}
                      placeholder={t("api.key")}
                      onChange={(key) => updateRow(row.id, { key })}
                    />
                    <Select
                      size="sm"
                      value={row.secret ? "secret" : "default"}
                      onChange={(type) => updateRow(row.id, { secret: type === "secret" })}
                      options={[
                        { value: "default", label: t("api.env.default") },
                        { value: "secret", label: t("api.env.secret") },
                      ]}
                      ariaLabel={t("api.env.type")}
                    />
                    <Field
                      mono
                      type={masked ? "password" : "text"}
                      value={row.initialValue}
                      placeholder={t("api.env.initialValue")}
                      onChange={(initialValue) => updateRow(row.id, { initialValue })}
                    />
                    <Field
                      mono
                      type={masked ? "password" : "text"}
                      value={row.currentValue}
                      placeholder={row.initialValue || t("api.env.currentValue")}
                      onChange={(currentValue) => updateRow(row.id, { currentValue })}
                    />
                    <Field
                      value={row.description}
                      placeholder={t("api.description")}
                      onChange={(description) => updateRow(row.id, { description })}
                    />
                    <span className="flex items-center justify-end gap-0.5">
                      {row.secret && (
                        <button
                          onClick={() => toggleReveal(row.id)}
                          title={masked ? t("api.env.reveal") : t("api.env.hide")}
                          className="rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                        >
                          {masked ? <Eye size={12} /> : <EyeOff size={12} />}
                        </button>
                      )}
                      <button
                        onClick={() => commit(rows.filter((r) => r.id !== row.id))}
                        title={t("api.removeRow")}
                        className="rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  </div>
                );
              })}

              <button
                onClick={addRow}
                className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
              >
                <Plus size={12} />
                {t("api.env.addVariable")}
              </button>
            </div>
          )}
        </div>
      </div>
    </ApiModal>
  );
}
