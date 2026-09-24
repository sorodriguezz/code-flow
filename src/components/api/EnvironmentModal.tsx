import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Globe,
  Layers,
  Loader2,
  Pencil,
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
import { chipClass, explorerClass, rowClass, sectionLabelClass, underlineTabClass } from "../common/recipes";
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
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const createEnvironment = useApiStore((s) => s.createEnvironment);
  const duplicateEnvironment = useApiStore((s) => s.duplicateEnvironment);
  const deleteEnvironment = useApiStore((s) => s.deleteEnvironment);
  const pushToast = useToastStore((s) => s.pushToast);

  const [tab, setTab] = useState<"variables" | "dynamic">("variables");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<ApiVariable[]>([]);
  /** What is being typed over the selected environment's name, while it is; `null` shows the stored
   *  name. Not a copy kept in sync by an effect: the field has to hold the right name on the very
   *  render that focuses it, or "select all" selects the previous environment's name and the new
   *  one lands after it with the caret at its end. */
  const [titleDraft, setTitleDraft] = useState<{ id: string; text: string } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  /** Set by "new" and by a row's rename: the title takes the caret, text selected, once it shows
   *  that environment. */
  const [renameFocusId, setRenameFocusId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [importing, setImporting] = useState(false);

  const list = ordered(environments);
  const selected = list.find((e) => e.id === selectedId) ?? null;
  // Each row's count, parsed once per store change rather than once per keystroke in the table. The
  // selected row reads the live draft instead (`rows`).
  const counts = useMemo(
    () => new Map(environments.map((e) => [e.id, parseVariables(e.variables).length])),
    [environments],
  );
  const secretCount = rows.filter((row) => row.secret).length;
  const selectedInUse = selected !== null && !selected.is_global && selected.id === activeEnvironmentId;

  useEffect(() => {
    if (!renameFocusId || selected?.id !== renameFocusId) return;
    setRenameFocusId(null);
    titleRef.current?.focus();
    titleRef.current?.select();
  }, [renameFocusId, selected?.id]);

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
    setRenameFocusId(created.id);
  };

  /** From a row: open that environment, and put the caret in its title. */
  const startRename = (environment: ApiEnvironment) => {
    select(environment.id);
    setRenameFocusId(environment.id);
  };

  /**
   * The title's edit, on Enter or on leaving the field.
   *
   * One write for the name *and* any variable edits still waiting on the debounce: both are the same
   * row, and two writes racing each other could land the old name back over the new one, or the old
   * variables over the edits.
   */
  const commitTitle = () => {
    if (!selected || selected.is_global || titleDraft?.id !== selected.id) return;
    const id = selected.id;
    const typed = titleDraft.text;
    const name = typed.trim();
    // Held until the write lands, so the old name doesn't flash back for the length of the round
    // trip — and only this draft: one typed since is left alone.
    const release = () => setTitleDraft((draft) => (draft?.id === id && draft.text === typed ? null : draft));
    if (!name || name === selected.name) {
      release();
      return;
    }
    const store = useApiStore.getState();
    const fresh = store.environments.find((e) => e.id === selected.id) ?? selected;
    let variables = fresh.variables;
    if (pendingRef.current?.id === selected.id) {
      variables = JSON.stringify(pendingRef.current.rows);
      pendingRef.current = null;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    }
    void store.updateEnvironment({ ...fresh, name, variables }).finally(release);
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
      width="max-w-6xl"
      height="h-[80vh]"
      onClose={onClose}
    >
      {/*
        Redrawn after "everything looks cramped and flat, and the name can't be changed" (user
        report). The list gained room, a count per environment and a mark on the one requests use;
        the detail gained a head that says which environment this is — its name as an editable
        title, what it holds, and the actions that act on it — in place of a table under two tabs
        that named nothing. Renaming used to be a double-click nobody could guess, into a field the
        row's hidden buttons squeezed to half its width.
      */}
      <div className="flex min-h-0 flex-1">
        {/* Environment list — the explorer of this dialog, half a step into the sunken tone so the
            sheet beside it reads as the page. */}
        <div className={`${explorerClass} w-[240px]`}>
          <div className="shrink-0 px-2.5">
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

          <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-2.5 pb-3">
            {list.length === 0 && (
              <p className="px-2 py-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("api.env.noEnvironments")}</p>
            )}
            {list.map((environment, index) => {
              const active = environment.id === selectedId;
              const EnvIcon = environment.is_global ? Globe : Layers;
              const count = active ? rows.length : (counts.get(environment.id) ?? 0);
              const inUse = !environment.is_global && environment.id === activeEnvironmentId;
              return (
                <Fragment key={environment.id}>
                  {/* Globals are always in scope, the rest are picked one at a time — a rule
                      between them says they are not the same kind of thing. */}
                  {index > 0 && list[index - 1].is_global && (
                    <div aria-hidden className="mx-2 my-1.5 h-px shrink-0 bg-[var(--cf-border)]" />
                  )}
                  <div
                    onClick={() => select(environment.id)}
                    onDoubleClick={() => {
                      if (!environment.is_global) startRename(environment);
                    }}
                    className={rowClass(active, "group h-8 shrink-0 cursor-pointer")}
                  >
                    <EnvIcon
                      size={15}
                      className={`shrink-0 ${active ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"}`}
                    />
                    <span className={`min-w-0 flex-1 truncate ${active ? "font-medium" : ""}`}>
                      {environment.is_global ? t("api.env.globals") : environment.name}
                    </span>
                    {inUse && (
                      <Tooltip label={t("api.env.inUse")} description={t("api.env.inUseHint")}>
                        <span
                          role="img"
                          aria-label={t("api.env.inUse")}
                          className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cf-success)]"
                        />
                      </Tooltip>
                    )}
                    {/* The count gives way to the row's actions under the pointer. */}
                    <span
                      className={`shrink-0 text-[11px] tabular-nums text-[var(--cf-text-faint)] ${
                        environment.is_global ? "" : "group-focus-within:hidden group-hover:hidden"
                      }`}
                    >
                      {count}
                    </span>
                    {/* Export used to live here too, as a hover-only icon that stripped secrets with
                        no way to say otherwise. One export, in the detail's head, acting on the
                        environment on screen — the same place Reset and Persist act from. Zero wide
                        rather than hidden until wanted, so Tab still reaches them. */}
                    {!environment.is_global && (
                      <span className="flex w-0 shrink-0 items-center overflow-hidden opacity-0 focus-within:w-auto focus-within:opacity-100 group-hover:w-auto group-hover:opacity-100">
                        <Tooltip label={t("api.rename")}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              startRename(environment);
                            }}
                            aria-label={t("api.rename")}
                            className={iconButtonClass({ size: "xs" })}
                          >
                            <Pencil size={12} />
                          </button>
                        </Tooltip>
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
                      </span>
                    )}
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>

        {/* Detail */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selected && (
            <div className="flex shrink-0 flex-wrap items-start gap-x-4 gap-y-3 px-6 pb-4 pt-5">
              <div className="flex min-w-0 flex-1 basis-[260px] items-start gap-3">
                <span
                  aria-hidden
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent-line)]"
                >
                  {selected.is_global ? <Globe size={17} /> : <Layers size={17} />}
                </span>
                <div className="min-w-0 flex-1">
                  {selected.is_global ? (
                    <h3 className="flex h-8 items-center truncate text-[17px] font-semibold text-[var(--cf-text)]">
                      {t("api.env.globals")}
                    </h3>
                  ) : (
                    // The name, as a title you can type into — the request builder's name field,
                    // a size up. Enter or leaving it saves; Escape puts the stored name back, and
                    // stops there rather than closing the dialog under it.
                    <Tooltip label={t("api.env.renameHint")} side="bottom">
                      <input
                        ref={titleRef}
                        value={titleDraft?.id === selected.id ? titleDraft.text : selected.name}
                        onChange={(e) => setTitleDraft({ id: selected.id, text: e.target.value })}
                        onBlur={commitTitle}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.currentTarget.blur();
                          if (e.key === "Escape") {
                            e.stopPropagation();
                            setTitleDraft(null);
                            requestAnimationFrame(() => titleRef.current?.blur());
                          }
                        }}
                        spellCheck={false}
                        aria-label={t("api.env.name")}
                        className="-ml-1.5 h-8 w-full max-w-[460px] rounded-md bg-transparent px-1.5 text-[17px] font-semibold text-[var(--cf-text)] outline-none transition-[background-color,box-shadow] duration-100 hover:bg-[var(--cf-hover)] focus:bg-[var(--cf-field)] focus:shadow-[inset_0_0_0_1px_var(--cf-accent)]"
                      />
                    </Tooltip>
                  )}
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-[var(--cf-text-muted)]">
                    <span>{t("api.env.variableCount", { n: String(rows.length) })}</span>
                    {secretCount > 0 && (
                      <>
                        <span aria-hidden className="text-[var(--cf-text-faint)]">
                          ·
                        </span>
                        <span>{t("api.env.secretCount", { n: String(secretCount) })}</span>
                      </>
                    )}
                    {selectedInUse && (
                      <Tooltip label={t("api.env.inUseHint")}>
                        <span className={chipClass("ok", "ml-1")}>
                          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
                          {t("api.env.inUse")}
                        </span>
                      </Tooltip>
                    )}
                  </p>
                  {selected.is_global && (
                    <p className="mt-1 text-[12px] text-[var(--cf-text-faint)]">{t("api.env.globalsHint")}</p>
                  )}
                </div>
              </div>

              {/* What acts on this environment's variables, beside its name — the short labels here,
                  the whole sentence in each tooltip. */}
              {tab === "variables" && (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 pt-0.5">
                  <Tooltip label={t("api.env.reset")}>
                    <button type="button" onClick={resetToInitial} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      <RotateCcw size={13} />
                      {t("api.env.resetShort")}
                    </button>
                  </Tooltip>
                  <Tooltip label={t("api.env.persist")}>
                    <button type="button" onClick={persistCurrent} className={buttonClass({ variant: "ghost", size: "sm" })}>
                      <Save size={13} />
                      {t("api.env.persistShort")}
                    </button>
                  </Tooltip>
                  {/* Only where it can mean something: an environment with no secret variable has
                      nothing to hold back, and a permanently visible "include secrets" next to an
                      export is how a warning stops being read. */}
                  {secretCount > 0 && (
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
                      className={buttonClass({ variant: "secondary", size: "sm" })}
                    >
                      <Download size={13} />
                      {t("api.export.title")}
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          )}

          <div
            role="tablist"
            className="flex h-10 shrink-0 items-stretch gap-5 overflow-x-auto border-b border-[var(--cf-border)] px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
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

          {tab === "dynamic" ? (
            <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
              <p className="mb-3 flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                <Wand2 size={13} className="shrink-0" />
                {t("api.env.dynamicHint")}
              </p>
              <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
                {DYNAMIC_VARIABLES.map((variable, index) => (
                  <button
                    key={variable.name}
                    type="button"
                    onClick={() => copyToken(variable.name)}
                    title={t("api.snippet.copy")}
                    className={`flex h-9 w-full items-center gap-3 px-3 text-left transition-colors duration-100 hover:bg-[var(--cf-hover)] ${
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
            <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
              {/* Keyed by environment so switching brings the new list up with its secrets masked
                  rather than inheriting whatever the previous one had revealed. */}
              <VariableTable key={selected.id} rows={rows} onChange={commit} />
            </div>
          )}
        </div>
      </div>
    </ApiModal>
  );
}
