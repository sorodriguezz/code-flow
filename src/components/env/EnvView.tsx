/**
 * «Entorno» — the repository's environment variables, every file side by side.
 *
 * Asked for 2026-10-23 as a section of the repository view: «tabla comparativa entre
 * archivos/ambientes: qué variable falta en cuál y cuál está vacía. Avisa si una variable que el
 * código lee no está en `.env.example`. Pasar un secreto al Llavero con un clic». Not the API
 * client's environments: those are request variables, these are the files a program reads.
 *
 * One table per group of comparable files (same folder, same kind — see `lib/env/analysis`); rows
 * are keys, columns are files or profiles. **Values are masked by default and the scan does not even
 * carry them**: a cell's value is fetched on a click on that cell, shown for 30 seconds, and kept only
 * in this component — never in a store, never logged.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  Eye,
  EyeOff,
  FileCode2,
  KeyRound,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  SquareAsterisk,
  TriangleAlert,
} from "lucide-react";
import { Button, iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Tooltip } from "../common/Tooltip";
import { chipClass, fieldClass, sectionLabelClass, toolbarClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useRepoEnvStore } from "../../state/repoEnvStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { promptAction } from "../../state/promptStore";
import { buildGroups, filterRows, problemCount, usageReport, type EnvCell, type EnvGroup, type EnvRow, type RowProblem } from "../../lib/env/analysis";
import { emptyRepoConfig, ignoreFile, setEnvironment } from "../../lib/env/config";
import { repoEnvAddKey, repoEnvReveal, type EnvSource } from "../../lib/tauri/envCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { EnvFilesConfig } from "./EnvFilesConfig";
import { EnvMoveDialog } from "./EnvMoveDialog";

/** How long a revealed value stays on screen. */
const REVEAL_MS = 30_000;

const FAMILY_LABEL: Record<EnvGroup["family"], TranslationKey> = {
  dotenv: "env.family.dotenv",
  dotnet: "env.family.dotnet",
  launch: "env.family.launch",
  compose: "env.family.compose",
  spring: "env.family.spring",
  yaml: "env.family.yaml",
  json: "env.family.json",
};

const PROBLEM_LABEL: Record<RowProblem, TranslationKey> = {
  notInExample: "env.problem.notInExample",
  missing: "env.problem.missing",
  onlyOne: "env.problem.onlyOne",
  empty: "env.problem.empty",
};

interface MoveTarget {
  source: EnvSource;
  key: string;
}

export function EnvView() {
  const t = useT();
  const project = useWorkspaceStore((s) => s.activeProject());
  const entry = useRepoEnvStore((s) => (project ? s.byProject[project.id] : undefined));
  const savedConfig = useRepoEnvStore((s) => (project ? s.repoConfig[project.id] : undefined));
  const [query, setQuery] = useState("");
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [move, setMove] = useState<MoveTarget | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, number>());

  const forget = useCallback(() => {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
    setRevealed({});
  }, []);

  // A repository is scanned the first time it is shown here, and every value shown for the last
  // one is dropped.
  useEffect(() => {
    forget();
    if (!project) return;
    void useRepoEnvStore.getState().loadConfig(project.id);
    if (!useRepoEnvStore.getState().byProject[project.id]?.scan) void useRepoEnvStore.getState().load(project.id, project.local_path);
  }, [project?.id, project?.local_path, forget]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => forget, [forget]);

  const scan = entry?.scan ?? null;
  const usage = entry?.usage ?? null;
  const groups = useMemo(() => (scan ? buildGroups(scan) : []), [scan]);
  const report = useMemo(() => (scan && usage ? usageReport(scan, usage) : null), [scan, usage]);
  const problems = problemCount(groups);

  if (!project) return null;

  const refresh = () => {
    forget();
    void useRepoEnvStore.getState().load(project.id, project.local_path);
  };
  const rescan = () => {
    forget();
    void useRepoEnvStore.getState().rescan(project.id, project.local_path);
  };

  const reveal = async (source: EnvSource, key: string) => {
    const id = `${source.id}\u0000${key}`;
    if (id in revealed) {
      window.clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      setRevealed((was) => {
        const next = { ...was };
        delete next[id];
        return next;
      });
      return;
    }
    try {
      const value = await repoEnvReveal(project.local_path, source.id, key);
      setRevealed((was) => ({ ...was, [id]: value }));
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id);
          setRevealed((was) => {
            const next = { ...was };
            delete next[id];
            return next;
          });
        }, REVEAL_MS),
      );
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const addToExample = async (path: string, key: string) => {
    try {
      await repoEnvAddKey(project.local_path, path, key);
      pushSuccessToast(t("env.added", { key, file: path }));
      rescan();
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  const config = savedConfig ?? emptyRepoConfig();
  const saveConfig = (next: typeof config) => void useRepoEnvStore.getState().saveConfig(project.id, project.local_path, next);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--cf-surface)]">
      <div className={toolbarClass}>
        <SquareAsterisk size={15} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="text-[14px] font-semibold text-[var(--cf-text)]">{t("env.title")}</span>
        {scan && (
          <span className="truncate text-[12px] text-[var(--cf-text-muted)]">
            {t("env.summary", { files: scan.files.length, problems })}
          </span>
        )}
        <div className="flex-1" />
        <div className="relative flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2 text-[var(--cf-text-faint)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("env.search")}
            aria-label={t("env.search")}
            className={fieldClass({ size: "sm", className: "w-[200px] pl-7" })}
          />
        </div>
        <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
          <Checkbox checked={onlyProblems} onChange={setOnlyProblems} />
          <ListFilter size={12} />
          {t("env.onlyProblems")}
        </label>
        <div className="relative">
          <Tooltip label={t("env.files.title")}>
            <button
              type="button"
              aria-label={t("env.files.title")}
              aria-pressed={configOpen}
              className={iconButtonClass({ active: configOpen })}
              onClick={() => setConfigOpen((open) => !open)}
            >
              <SlidersHorizontal size={14} />
            </button>
          </Tooltip>
          {configOpen && <EnvFilesConfig projectId={project.id} repoPath={project.local_path} scan={scan} onClose={() => setConfigOpen(false)} />}
        </div>
        <Tooltip label={t("env.refresh")}>
          <button type="button" aria-label={t("env.refresh")} className={iconButtonClass()} onClick={refresh} disabled={entry?.loading}>
            {entry?.loading ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
        {entry?.error && <p className="mt-4 text-[12px] text-[var(--cf-danger)]">{entry.error}</p>}
        {scan && scan.files.length === 0 && (
          <div className="mt-6 flex items-center gap-2 text-[12.5px] text-[var(--cf-text-muted)]">
            {t("env.none")}
            <Button size="sm" onClick={() => setConfigOpen(true)}>
              {t("env.files.title")}
            </Button>
          </div>
        )}
        {report && <UsagePanel report={report} onAdd={(path, key) => void addToExample(path, key)} />}
        {entry?.usageLoading && (
          <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-faint)]">
            <LoaderCircle size={11} className="animate-spin" />
            {t("env.usage.scanning")}
          </p>
        )}
        {groups.map((group) => (
          <GroupTable
            key={group.id}
            group={group}
            rows={filterRows(group.rows, query, onlyProblems)}
            revealed={revealed}
            onReveal={(source, key) => void reveal(source, key)}
            onMove={(source, key) => setMove({ source, key })}
            onAdd={(path, key) => void addToExample(path, key)}
            onOpen={(path, line) => useUiStore.getState().openInEditor(path, line)}
            onRename={async (source) => {
              const label = await promptAction(t("env.renamePrompt", { file: source.sub ? `${source.path} · ${source.sub}` : source.path }), {
                initial: source.environment,
                placeholder: source.environmentAuto,
                allowEmpty: true,
              });
              if (label !== null) saveConfig(setEnvironment(config, source.id, label, source.environmentAuto));
            }}
            onIgnore={(source) => saveConfig(ignoreFile(config, source.path))}
          />
        ))}
      </div>

      {move && (
        <EnvMoveDialog
          projectId={project.id}
          repoPath={project.local_path}
          repoName={project.name}
          sourceId={move.source.id}
          path={move.source.path}
          sub={move.source.sub}
          format={move.source.format}
          envKey={move.key}
          onClose={() => setMove(null)}
          onMoved={rescan}
        />
      )}
    </div>
  );
}

function UsagePanel({ report, onAdd }: { report: ReturnType<typeof usageReport>; onAdd: (path: string, key: string) => void }) {
  const t = useT();
  const [leftoversOpen, setLeftoversOpen] = useState(false);
  if (report.findings.length === 0 && report.leftovers.length === 0 && !report.noExample) return null;
  return (
    <section className="mt-4 rounded-lg border border-[var(--cf-border)] p-3">
      <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--cf-text)]">
        <FileCode2 size={14} className="text-[var(--cf-text-muted)]" />
        {t("env.usage.title")}
      </h3>
      {report.noExample && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-[var(--cf-warning)]">
          <TriangleAlert size={12} />
          {t("env.usage.noExample")}
        </p>
      )}
      {report.findings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {report.findings.map((finding) => (
            <li key={`${finding.read.kind}:${finding.read.key}`} className="flex flex-wrap items-center gap-2 text-[12px]">
              {finding.problem === "undefined" ? (
                <CircleAlert size={12} className="shrink-0 text-[var(--cf-danger)]" />
              ) : (
                <TriangleAlert size={12} className="shrink-0 text-[var(--cf-warning)]" />
              )}
              <code className="font-mono text-[12px] text-[var(--cf-text)]">{finding.read.key}</code>
              <span className="text-[var(--cf-text-muted)]">
                {t(finding.problem === "undefined" ? "env.usage.undefined" : "env.usage.notInExample", { file: finding.example ?? ".env.example" })}
              </span>
              {finding.read.places.slice(0, 2).map((place) => (
                <button
                  key={`${place.path}:${place.line}`}
                  type="button"
                  className="truncate font-mono text-[11px] text-[var(--cf-accent)] hover:underline"
                  onClick={() => useUiStore.getState().openInEditor(place.path, place.line)}
                >
                  {place.path}:{place.line}
                </button>
              ))}
              {finding.read.count > 2 && <span className="text-[11px] text-[var(--cf-text-faint)]">{t("env.usage.more", { count: finding.read.count - 2 })}</span>}
              {finding.example && (
                <Button size="sm" variant="ghost" onClick={() => onAdd(finding.example!, finding.read.key)}>
                  <Plus size={11} />
                  {t("env.usage.addTo", { file: finding.example })}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {report.leftovers.length > 0 && (
        <div className="mt-2">
          <button type="button" className="text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]" onClick={() => setLeftoversOpen((o) => !o)}>
            {t("env.usage.leftovers", { count: report.leftovers.length })}
          </button>
          {leftoversOpen && (
            <p className="mt-1 flex flex-wrap gap-1">
              {report.leftovers.map((left) => (
                <Tooltip key={left.key} label={left.paths.join(", ")}>
                  <span className={chipClass("neutral", "font-mono")}>{left.key}</span>
                </Tooltip>
              ))}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function GroupTable({
  group,
  rows,
  revealed,
  onReveal,
  onMove,
  onAdd,
  onOpen,
  onRename,
  onIgnore,
}: {
  group: EnvGroup;
  rows: EnvRow[];
  revealed: Record<string, string>;
  onReveal: (source: EnvSource, key: string) => void;
  onMove: (source: EnvSource, key: string) => void;
  onAdd: (path: string, key: string) => void;
  onOpen: (path: string, line?: number) => void;
  onRename: (source: EnvSource) => void;
  onIgnore: (source: EnvSource) => void;
}) {
  const t = useT();
  const [menu, setMenu] = useState<{ source: EnvSource; rect: DOMRect } | null>(null);
  const label = [group.dir || t("env.root"), t(FAMILY_LABEL[group.family]), group.service].filter(Boolean).join(" · ");
  const menuItems = (source: EnvSource): MenuItem[] => [
    { label: t("env.column.open"), icon: FileCode2, onClick: () => onOpen(source.path) },
    { label: t("env.column.rename"), icon: SlidersHorizontal, onClick: () => onRename(source) },
    { label: t("env.files.ignore"), icon: EyeOff, onClick: () => onIgnore(source), separated: true },
  ];

  return (
    <section className="mt-5">
      <h3 className={`${sectionLabelClass} px-0`}>{label}</h3>
      {rows.length === 0 ? (
        <p className="text-[12px] text-[var(--cf-text-faint)]">{t(group.rows.length === 0 ? "env.groupEmpty" : "env.noMatches")}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--cf-border)]">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="bg-[var(--cf-sunken)]">
                <th className="sticky left-0 z-10 min-w-[220px] bg-[var(--cf-sunken)] px-3 py-1.5 text-left font-medium text-[var(--cf-text-muted)]">
                  {t("env.variable")}
                </th>
                {group.sources.map((source) => (
                  <th key={source.id} className="min-w-[160px] border-l border-[var(--cf-border)] px-2 py-1.5 text-left font-normal">
                    <div className="flex items-center gap-1.5">
                      <span className={chipClass(source.example ? "info" : source.environment.startsWith("prod") ? "warn" : "neutral")}>{source.environment}</span>
                      <Tooltip label={source.path}>
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                          {source.sub ?? source.path.split("/").pop()}
                        </span>
                      </Tooltip>
                      <button
                        type="button"
                        aria-label={t("env.column.menu")}
                        className={iconButtonClass({ size: "xs" })}
                        onClick={(e) => setMenu({ source, rect: e.currentTarget.getBoundingClientRect() })}
                      >
                        <MoreHorizontal size={12} />
                      </button>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="group/row border-t border-[var(--cf-border)] hover:bg-[var(--cf-hover)]">
                  <td className="sticky left-0 z-10 bg-[var(--cf-surface)] px-3 py-1 align-middle group-hover/row:bg-[color-mix(in_oklab,var(--cf-hover)_100%,var(--cf-surface))]">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <code className="break-all font-mono text-[12px] text-[var(--cf-text)]">{row.key}</code>
                      {row.problems.map((problem) => (
                        <span key={problem} className={chipClass(problem === "empty" ? "neutral" : problem === "notInExample" ? "warn" : "bad")}>
                          {t(PROBLEM_LABEL[problem], { count: row.missingIn.length })}
                        </span>
                      ))}
                    </div>
                  </td>
                  {group.sources.map((source) => (
                      <Cell
                        key={source.id}
                        cell={row.cells[source.id]}
                        source={source}
                        rowKey={row.key}
                        value={revealed[`${source.id}\u0000${row.key}`]}
                        canAdd={source.example && source.format === "dotenv" && row.cells[source.id].state === "missing"}
                        onReveal={() => onReveal(source, row.key)}
                        onMove={() => onMove(source, row.key)}
                        onAdd={() => onAdd(source.path, row.key)}
                        onOpen={(line) => onOpen(source.path, line)}
                      />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.rect.left}
          y={menu.rect.bottom}
          anchor={{ top: menu.rect.top, bottom: menu.rect.bottom, left: menu.rect.left, right: menu.rect.right, align: "end" }}
          items={menuItems(menu.source)}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}

function Cell({
  cell,
  source,
  rowKey,
  value,
  canAdd,
  onReveal,
  onMove,
  onAdd,
  onOpen,
}: {
  cell: EnvCell;
  source: EnvSource;
  rowKey: string;
  value: string | undefined;
  canAdd: boolean;
  onReveal: () => void;
  onMove: () => void;
  onAdd: () => void;
  onOpen: (line: number) => void;
}) {
  const t = useT();
  const base = "border-l border-[var(--cf-border)] px-2 py-1 align-middle";
  if (cell.state === "missing") {
    return (
      <td className={`${base} bg-[color-mix(in_oklab,var(--cf-danger)_5%,transparent)]`}>
        <div className="flex items-center gap-1">
          <span className="text-[11.5px] text-[var(--cf-danger)]">{t("env.cell.missing")}</span>
          {canAdd && (
            <Tooltip label={t("env.usage.addTo", { file: source.path })}>
              <button type="button" aria-label={t("env.usage.addTo", { file: source.path })} className={iconButtonClass({ size: "xs" })} onClick={onAdd}>
                <Plus size={11} />
              </button>
            </Tooltip>
          )}
        </div>
      </td>
    );
  }
  const entry = cell.entry!;
  if (cell.state === "reference") {
    return (
      <td className={base}>
        <Tooltip label={t("env.cell.referenceHint", { id: entry.reference ?? "" })}>
          <button type="button" className={chipClass("accent")} onClick={() => onOpen(entry.line)}>
            <KeyRound size={11} />
            {t("env.cell.reference")}
          </button>
        </Tooltip>
      </td>
    );
  }
  if (cell.state === "empty") {
    return (
      <td className={base}>
        <button type="button" className={chipClass(source.example ? "neutral" : "warn")} onClick={() => onOpen(entry.line)}>
          {t("env.cell.empty")}
        </button>
      </td>
    );
  }
  const movable = !entry.refused && !source.example;
  return (
    <td className={base}>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-label={t(value === undefined ? "env.cell.reveal" : "env.cell.hide", { key: rowKey })}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-[var(--cf-hover)]"
          onClick={onReveal}
        >
          {value === undefined ? (
            <>
              <Eye size={11} className="shrink-0 text-[var(--cf-text-faint)]" />
              <span className="font-mono tracking-[0.15em] text-[var(--cf-text-muted)]">••••••</span>
            </>
          ) : (
            <>
              <EyeOff size={11} className="shrink-0 text-[var(--cf-text-faint)]" />
              <span className="min-w-0 max-w-[260px] select-text truncate font-mono text-[11.5px] text-[var(--cf-text)]" title={value}>
                {value}
              </span>
            </>
          )}
        </button>
        {movable ? (
          <Tooltip label={t("env.cell.move")}>
            <button
              type="button"
              aria-label={t("env.cell.move")}
              className={iconButtonClass({ size: "xs", className: "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100" })}
              onClick={onMove}
            >
              <KeyRound size={11} />
            </button>
          </Tooltip>
        ) : (
          entry.refused && (
            <Tooltip label={t(entry.refused as TranslationKey)}>
              <span className="opacity-0 group-hover/row:opacity-100">
                <KeyRound size={11} className="text-[var(--cf-text-faint)]" />
              </span>
            </Tooltip>
          )
        )}
      </div>
    </td>
  );
}
