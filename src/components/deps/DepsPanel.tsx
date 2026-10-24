/**
 * Revisor › Dependencias (user, 2026-10-23: «En Revisor, la pestaña de calidad de proyecto, como
 * sección «Dependencias», más una vista de todo el workspace»).
 *
 * «Este repo»: the summary, the filtered table, a row's details and the vulnerable packages only a
 * lockfile mentions. «Todo el workspace»: one row per dependency, one column per repository, the
 * version each uses — who is behind, who is vulnerable. Both feed the same batch update.
 *
 * An analysis runs in the backend and survives leaving the tab; this screen only draws its progress.
 * No empty-state screen: before the first analysis the table is empty and «Analizar» is the way in.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, ClipboardCopy, ExternalLink, GitPullRequest, Loader2, RefreshCw, Search } from "lucide-react";
import { useDepsStore } from "../../state/depsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT, type Translate } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { writeClipboardText } from "../../lib/clipboard";
import type { DepsAdvisory, DepsEcosystem, DepsProgress, DepsReport, DepsRow, DepsSeverity, DepsUpdateKind } from "../../lib/tauri/depsCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { Project } from "../../types/domain";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { chipClass, fieldClass } from "../common/recipes";
import {
  EMPTY_FILTERS,
  SEVERITY_ORDER,
  filterRows,
  packageKey,
  pivot,
  presetSelection,
  rowId,
  summarize,
  toUpdateItem,
  transitiveAsText,
  worstSeverity,
  type RowFilters,
  type SelectionPreset,
  type UpdateTarget,
} from "./depsLogic";
import { DepsUpdateDialog, type DepsBatch } from "./DepsUpdateDialog";

const ECOSYSTEM_LABEL: Record<DepsEcosystem, string> = {
  npm: "npm",
  cargo: "Cargo",
  nuget: "NuGet",
  pypi: "PyPI",
  go: "Go",
  maven: "Maven",
};

const UPDATE_LABEL: Record<Exclude<DepsUpdateKind, "none">, TranslationKey> = {
  major: "deps.kindMajor",
  minor: "deps.kindMinor",
  patch: "deps.kindPatch",
};

const SEVERITY_LABEL: Record<DepsSeverity, TranslationKey> = {
  critical: "deps.sevCritical",
  high: "deps.sevHigh",
  medium: "deps.sevMedium",
  low: "deps.sevLow",
  unknown: "deps.sevUnknown",
};

function severityTone(s: DepsSeverity): "bad" | "warn" | "neutral" {
  return s === "critical" || s === "high" ? "bad" : s === "medium" ? "warn" : "neutral";
}

function kindTone(k: DepsUpdateKind): "bad" | "warn" | "info" | "neutral" {
  return k === "major" ? "warn" : k === "minor" ? "info" : "neutral";
}

function progressText(t: Translate, p: DepsProgress | undefined): string {
  if (!p) return t("deps.analyzing");
  if (p.phase === "registry") return t("deps.phaseRegistry", { done: p.done, total: p.total });
  if (p.phase === "osv") return t("deps.phaseOsv");
  return t("deps.phaseScan");
}

type Scope = "repo" | "workspace";

export function DepsPanel({ project }: { project: Project }) {
  const t = useT();
  const [scope, setScope] = useState<Scope>("repo");
  const workspaceProjects = useWorkspaceStore((s) => s.projectsByWorkspace[project.workspace_id]) ?? EMPTY_PROJECTS;
  const reports = useDepsStore((s) => s.reports);
  const analyzing = useDepsStore((s) => s.analyzing);
  const progress = useDepsStore((s) => s.progress);
  const loadReports = useDepsStore((s) => s.loadReports);
  const analyze = useDepsStore((s) => s.analyze);
  const analyzeMany = useDepsStore((s) => s.analyzeMany);
  const [dialog, setDialog] = useState<DepsBatch[] | null>(null);

  const ids = useMemo(() => workspaceProjects.map((p) => p.id), [workspaceProjects]);
  useEffect(() => {
    void loadReports(scope === "repo" ? [project.id] : ids).catch(() => {});
  }, [scope, project.id, ids, loadReports]);

  const report = reports[project.id] ?? null;
  const busy = !!analyzing[project.id];
  const anyBusy = ids.some((id) => analyzing[id]);

  const onAnalyze = () => {
    const work = scope === "repo" ? analyze(project.id) : analyzeMany(ids);
    void work.catch((e: unknown) => pushErrorToast(String(e) === "busy" ? t("deps.busy") : String(e)));
  };

  return (
    <div className="pb-4">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Segmented<Scope>
          layoutId="cf-deps-scope"
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: "repo", label: t("deps.scopeRepo") },
            { value: "workspace", label: t("deps.scopeWorkspace") },
          ]}
          ariaLabel={t("deps.scope")}
        />
        <span className="flex-1" />
        {scope === "repo" && report && !busy && (
          <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t("deps.analyzedAt", { when: new Date(report.analyzedAt).toLocaleString() })}</span>
        )}
        {(scope === "repo" ? busy : anyBusy) && (
          <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
            <Loader2 size={12} className="animate-spin" />
            {scope === "repo" ? progressText(t, progress[project.id]) : t("deps.analyzingWorkspace", { name: workspaceProjects.find((p) => analyzing[p.id])?.name ?? "" })}
          </span>
        )}
        <button type="button" disabled={scope === "repo" ? busy : anyBusy} onClick={onAnalyze} className={buttonClass({ variant: "primary", size: "sm" })}>
          <RefreshCw size={12} />
          {scope === "repo" ? t("deps.analyze") : t("deps.analyzeAll")}
        </button>
      </div>

      {scope === "repo" ? (
        <RepoView project={project} report={report} onUpdate={(batch) => setDialog([batch])} />
      ) : (
        <WorkspaceView projects={workspaceProjects} reports={reports} onUpdate={setDialog} />
      )}

      {dialog && (
        <DepsUpdateDialog
          batches={dialog}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

const EMPTY_PROJECTS: Project[] = [];

function SummaryChips({ report }: { report: DepsReport | null }) {
  const t = useT();
  const s = summarize(report);
  const outdated = s.outdated.major + s.outdated.minor + s.outdated.patch;
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
      <Tooltip label={t("deps.outdatedHint", { major: s.outdated.major, minor: s.outdated.minor, patch: s.outdated.patch })}>
        <span className={chipClass(outdated > 0 ? "info" : "neutral")}>
          {t("deps.chipOutdated", { n: outdated })} · {s.outdated.major}/{s.outdated.minor}/{s.outdated.patch}
        </span>
      </Tooltip>
      {s.vulnerableTotal + s.transitiveVulnerable === 0 ? (
        <span className={chipClass(report && !report.osvError ? "ok" : "neutral")}>{report?.osvError ? t("deps.osvUnknown") : t("deps.chipNoVulns")}</span>
      ) : (
        SEVERITY_ORDER.filter((sev) => s.vulnerable[sev] > 0).map((sev) => (
          <span key={sev} className={chipClass(severityTone(sev))}>
            {t("deps.chipVulns", { n: s.vulnerable[sev], severity: t(SEVERITY_LABEL[sev]) })}
          </span>
        ))
      )}
      {(s.licenseFlag > 0 || s.licenseWarn > 0) && (
        <span className={chipClass(s.licenseFlag > 0 ? "bad" : "warn")}>{t("deps.chipLicenses", { n: s.licenseFlag + s.licenseWarn })}</span>
      )}
      {report?.osvError && (
        <Tooltip label={report.osvError}>
          <span className={chipClass("warn")}>{t("deps.osvError")}</span>
        </Tooltip>
      )}
    </div>
  );
}

function RepoView({ project, report, onUpdate }: { project: Project; report: DepsReport | null; onUpdate: (batch: DepsBatch) => void }) {
  const t = useT();
  const [filters, setFilters] = useState<RowFilters>(EMPTY_FILTERS);
  const [open, setOpen] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, UpdateTarget>>(new Map());
  useEffect(() => setSelected(new Map()), [report?.analyzedAt]);

  const rows = useMemo(() => filterRows(report?.rows ?? [], filters), [report, filters]);
  const ecosystems = useMemo(() => [...new Set((report?.rows ?? []).map((r) => r.ecosystem))], [report]);

  const toggle = (row: DepsRow) => {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(rowId(row))) next.delete(rowId(row));
      else {
        const target: UpdateTarget | null = row.bumpCompatible && row.compatibleUpdate !== "none" ? "compatible" : row.bumpLatest && row.update !== "none" ? "latest" : null;
        if (target) next.set(rowId(row), target);
      }
      return next;
    });
  };
  const applyPreset = (preset: SelectionPreset) => setSelected(presetSelection(report?.rows ?? [], preset));

  const startUpdate = () => {
    const items = (report?.rows ?? [])
      .filter((r) => selected.has(rowId(r)))
      .map((r) => toUpdateItem(r, selected.get(rowId(r)) ?? "compatible"))
      .filter((i): i is NonNullable<typeof i> => !!i);
    if (items.length > 0) onUpdate({ project, items });
  };

  return (
    <>
      <SummaryChips report={report} />
      <div className="flex flex-wrap items-center gap-2 border-y border-[var(--cf-border)] px-3 py-1.5">
        <div className="w-44">
          <Select
            size="sm"
            value={filters.ecosystem}
            onChange={(v) => setFilters((f) => ({ ...f, ecosystem: v as RowFilters["ecosystem"] }))}
            options={[{ value: "all", label: t("deps.allEcosystems") }, ...ecosystems.map((e) => ({ value: e, label: ECOSYSTEM_LABEL[e] }))]}
            ariaLabel={t("deps.ecosystem")}
          />
        </div>
        <div className="w-36">
          <Select
            size="sm"
            value={filters.update}
            onChange={(v) => setFilters((f) => ({ ...f, update: v as RowFilters["update"] }))}
            options={[
              { value: "all", label: t("deps.updateAll") },
              { value: "outdated", label: t("deps.updateOutdated") },
              { value: "major", label: t("deps.kindMajor") },
              { value: "minor", label: t("deps.kindMinor") },
              { value: "patch", label: t("deps.kindPatch") },
            ]}
            ariaLabel={t("deps.updateKind")}
          />
        </div>
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={filters.vulnerableOnly} onChange={(c) => setFilters((f) => ({ ...f, vulnerableOnly: c }))} />
          {t("deps.onlyVulnerable")}
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={filters.licenseOnly} onChange={(c) => setFilters((f) => ({ ...f, licenseOnly: c }))} />
          {t("deps.onlyLicenses")}
        </label>
        <div className="relative min-w-[140px] flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder={t("deps.search")}
            className={fieldClass({ size: "sm", className: "w-full pl-7" })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-[12px]">
        <span className="text-[var(--cf-text-muted)]">{t("deps.select")}</span>
        <button type="button" onClick={() => applyPreset("minorPatch")} className={buttonClass({ variant: "ghost", size: "sm" })}>
          {t("deps.presetMinorPatch")}
        </button>
        <button type="button" onClick={() => applyPreset("vulnerable")} className={buttonClass({ variant: "ghost", size: "sm" })}>
          {t("deps.presetVulnerable")}
        </button>
        {selected.size > 0 && (
          <button type="button" onClick={() => setSelected(new Map())} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("deps.clearSelection")}
          </button>
        )}
        <span className="flex-1" />
        <button type="button" disabled={selected.size === 0} onClick={startUpdate} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <GitPullRequest size={12} />
          {t("deps.updateSelected", { n: selected.size })}
        </button>
      </div>

      <table className="w-full table-fixed border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-[var(--cf-border)] text-left text-[11px] text-[var(--cf-text-muted)]">
            <th className="w-8 px-3 py-1.5" />
            <th className="px-1 py-1.5 font-medium">{t("deps.colPackage")}</th>
            <th className="w-[13%] px-1 py-1.5 font-medium">{t("deps.colRequirement")}</th>
            <th className="w-[11%] px-1 py-1.5 font-medium">{t("deps.colCurrent")}</th>
            <th className="w-[19%] px-1 py-1.5 font-medium">{t("deps.colAvailable")}</th>
            <th className="w-[12%] px-1 py-1.5 font-medium">{t("deps.colVulns")}</th>
            <th className="w-[14%] px-1 py-1.5 font-medium">{t("deps.colLicense")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const id = rowId(row);
            const expanded = open === id;
            const worst = worstSeverity(row.advisories);
            const canUpdate = (row.bumpCompatible && row.compatibleUpdate !== "none") || (row.bumpLatest && row.update !== "none");
            return (
              <Fragment key={id}>
                <tr className="cursor-pointer border-b border-[var(--cf-border)] hover:bg-[var(--cf-hover)]" onClick={() => setOpen(expanded ? null : id)}>
                  <td className="px-3 py-1" onClick={(e) => e.stopPropagation()}>
                    {canUpdate && <Checkbox checked={selected.has(id)} onChange={() => toggle(row)} />}
                  </td>
                  <td className="truncate px-1 py-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ChevronRight size={11} className={`shrink-0 text-[var(--cf-text-faint)] transition-transform ${expanded ? "rotate-90" : ""}`} />
                      <span className="truncate font-medium text-[var(--cf-text)]">{row.name}</span>
                      <span className={chipClass("neutral")}>{ECOSYSTEM_LABEL[row.ecosystem]}</span>
                      <span className="truncate text-[11px] text-[var(--cf-text-faint)]">{row.manifest}</span>
                    </span>
                  </td>
                  <td className="truncate px-1 py-1 font-mono text-[11.5px] text-[var(--cf-text-muted)]">{row.requirement || "—"}</td>
                  <td className="truncate px-1 py-1 font-mono text-[11.5px] text-[var(--cf-text)]">
                    {row.current ?? "—"}
                    {!row.locked && row.current && <span className="text-[var(--cf-text-faint)]"> ≥</span>}
                  </td>
                  <td className="truncate px-1 py-1">
                    {row.error ? (
                      <Tooltip label={row.error}>
                        <span className="text-[11px] text-[var(--cf-text-faint)]">{t("deps.lookupFailed")}</span>
                      </Tooltip>
                    ) : row.update === "none" ? (
                      <span className="text-[11px] text-[var(--cf-text-faint)]">{row.tooRecent ? t("deps.onlyTooRecent", { v: row.tooRecent }) : t("deps.upToDate")}</span>
                    ) : (
                      <span className="flex items-center gap-1">
                        <span className="font-mono text-[11.5px] text-[var(--cf-text)]">{selected.get(id) === "compatible" ? row.compatible : row.latest}</span>
                        <span className={chipClass(kindTone(selected.get(id) === "compatible" ? row.compatibleUpdate : row.update))}>
                          {t(UPDATE_LABEL[(selected.get(id) === "compatible" ? row.compatibleUpdate : row.update) as Exclude<DepsUpdateKind, "none">] ?? "deps.kindPatch")}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="px-1 py-1">
                    {worst && (
                      <span className={chipClass(severityTone(worst))}>
                        {row.advisories.length} · {t(SEVERITY_LABEL[worst])}
                      </span>
                    )}
                  </td>
                  <td className="truncate px-1 py-1">
                    <LicenseChip row={row} />
                  </td>
                </tr>
                {expanded && (
                  <tr className="border-b border-[var(--cf-border)] bg-[var(--cf-surface-raised)]">
                    <td />
                    <td colSpan={6} className="px-1 py-2">
                      <RowDetails row={row} target={selected.get(id) ?? null} onTarget={(target) => setSelected((m) => new Map(m).set(id, target))} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {report && report.transitive.length > 0 && (
        <div className="mt-3 select-text px-3">
          <div className="mb-1 flex items-center gap-2">
            <p className="text-[12px] font-medium text-[var(--cf-text)]">{t("deps.transitiveTitle", { n: report.transitive.length })}</p>
            <CopyTransitiveButton items={report.transitive} />
          </div>
          <p className="mb-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("deps.transitiveHint")}</p>
          <ul className="space-y-1">
            {report.transitive.map((tv) => (
              <li key={`${tv.ecosystem}|${tv.name}|${tv.version}`} className="text-[12px]">
                <span className="font-medium text-[var(--cf-text)]">{tv.name}</span> <span className="font-mono text-[11.5px] text-[var(--cf-text-muted)]">{tv.version}</span>{" "}
                <span className="text-[11px] text-[var(--cf-text-faint)]">{tv.lockfile}</span>
                <AdvisoryList advisories={tv.advisories} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function CopyTransitiveButton({ items }: { items: DepsReport["transitive"] }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  return (
    <button
      type="button"
      className={buttonClass({ variant: "ghost", size: "sm" })}
      onClick={() =>
        void writeClipboardText(transitiveAsText(items))
          .then(() => setCopied(true))
          .catch((e) => pushErrorToast(String(e)))
      }
    >
      {copied ? <Check size={12} /> : <ClipboardCopy size={12} />}
      {copied ? t("common.copied") : t("deps.copyTransitive")}
    </button>
  );
}

function LicenseChip({ row }: { row: DepsRow }) {
  const t = useT();
  if (row.licenseStatus === "unavailable") return <span className="text-[11px] text-[var(--cf-text-faint)]">—</span>;
  const tone = row.licenseStatus === "flag" ? "bad" : row.licenseStatus === "warn" ? "warn" : "neutral";
  return (
    <Tooltip label={row.license ?? t("deps.noLicense")}>
      <span className={chipClass(tone, "max-w-full truncate")}>{row.license ?? t("deps.noLicense")}</span>
    </Tooltip>
  );
}

function AdvisoryList({ advisories }: { advisories: DepsAdvisory[] }) {
  const t = useT();
  return (
    <ul className="mt-0.5 space-y-0.5 pl-3">
      {advisories.map((a) => (
        <li key={a.id} className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <span className={chipClass(severityTone(a.severity))}>
            {t(SEVERITY_LABEL[a.severity])}
            {a.score != null ? ` ${a.score.toFixed(1)}` : ""}
          </span>
          <button type="button" onClick={() => void openExternalUrl(a.url).catch(() => {})} className="inline-flex items-center gap-1 font-mono text-[var(--cf-accent)] hover:underline">
            {a.aliases.find((x) => x.startsWith("CVE-")) ?? a.id}
            <ExternalLink size={10} />
          </button>
          <span className="min-w-0 truncate text-[var(--cf-text-muted)]">{a.summary}</span>
          {a.fixed && <span className="text-[var(--cf-success)]">{t("deps.fixedIn", { v: a.fixed })}</span>}
        </li>
      ))}
    </ul>
  );
}

function RowDetails({ row, target, onTarget }: { row: DepsRow; target: UpdateTarget | null; onTarget: (t: UpdateTarget) => void }) {
  const t = useT();
  const both = row.bumpCompatible && row.bumpLatest && row.compatible !== row.latest && row.compatibleUpdate !== "none";
  return (
    <div className="space-y-1.5 text-[12px] text-[var(--cf-text-muted)]">
      <p>
        {t("deps.detailWhere", { manifest: row.manifest, section: row.section })}
        {row.property ? ` · \${${row.property}}` : ""}
        {row.stale ? ` · ${t("deps.stale")}` : ""}
      </p>
      {row.latest && (
        <p>
          {t("deps.detailLatest", { v: row.latest })}
          {row.compatible && row.compatible !== row.latest ? ` · ${t("deps.detailCompatible", { v: row.compatible })}` : ""}
          {row.tooRecent ? ` · ${t("deps.detailTooRecent", { v: row.tooRecent })}` : ""}
        </p>
      )}
      {!row.bumpLatest && row.update !== "none" && <p>{t("deps.notRewritable")}</p>}
      {both && target && (
        <div className="w-64">
          <Segmented<UpdateTarget>
            layoutId={`cf-deps-target-${rowId(row)}`}
            size="sm"
            value={target}
            onChange={onTarget}
            options={[
              { value: "compatible", label: t("deps.targetCompatible", { v: row.compatible ?? "" }) },
              { value: "latest", label: t("deps.targetLatest", { v: row.latest ?? "" }) },
            ]}
          />
        </div>
      )}
      {row.advisories.length > 0 && <AdvisoryList advisories={row.advisories} />}
      {row.url && (
        <button type="button" onClick={() => void openExternalUrl(row.url ?? "").catch(() => {})} className="inline-flex items-center gap-1 text-[var(--cf-accent)] hover:underline">
          {t("deps.openRegistry")}
          <ExternalLink size={10} />
        </button>
      )}
    </div>
  );
}

function WorkspaceView({ projects, reports, onUpdate }: { projects: Project[]; reports: Record<string, DepsReport>; onUpdate: (batches: DepsBatch[]) => void }) {
  const t = useT();
  const [search, setSearch] = useState("");
  const [sharedOnly, setSharedOnly] = useState(true);
  const [behindOnly, setBehindOnly] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const analyzed = useMemo(() => projects.filter((p) => reports[p.id]), [projects, reports]);
  const rows = useMemo(() => pivot(analyzed.map((p) => reports[p.id])), [analyzed, reports]);
  const q = search.trim().toLowerCase();
  const visible = rows.filter((r) => (!sharedOnly || r.repos > 1) && (!behindOnly || r.behindCount > 0) && (!q || r.name.toLowerCase().includes(q)));

  /** For every repository: its rows of the picked packages (newest target), or a preset's rows. */
  const batchesFor = (select: (report: DepsReport) => Map<string, UpdateTarget>): DepsBatch[] =>
    analyzed
      .map((project) => {
        const report = reports[project.id];
        const chosen = select(report);
        const items = report.rows
          .filter((r) => chosen.has(rowId(r)))
          .map((r) => toUpdateItem(r, chosen.get(rowId(r)) ?? "latest"))
          .filter((i): i is NonNullable<typeof i> => !!i);
        return { project, items };
      })
      .filter((b) => b.items.length > 0);

  const pickedBatches = () =>
    batchesFor((report) => {
      const out = new Map<string, UpdateTarget>();
      for (const r of report.rows) {
        if (!picked.has(packageKey(r.ecosystem, r.name))) continue;
        if (r.bumpLatest && r.update !== "none") out.set(rowId(r), "latest");
        else if (r.bumpCompatible && r.compatibleUpdate !== "none") out.set(rowId(r), "compatible");
      }
      return out;
    });

  const open = (batches: DepsBatch[]) => {
    if (batches.length === 0) pushErrorToast(t("deps.nothingToUpdate"));
    else onUpdate(batches);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-y border-[var(--cf-border)] px-3 py-1.5">
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={sharedOnly} onChange={setSharedOnly} />
          {t("deps.sharedOnly")}
        </label>
        <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={behindOnly} onChange={setBehindOnly} />
          {t("deps.behindOnly")}
        </label>
        <div className="relative min-w-[140px] flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("deps.search")} className={fieldClass({ size: "sm", className: "w-full pl-7" })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-[12px]">
        <span className="text-[var(--cf-text-muted)]">{t("deps.reposAnalyzed", { n: analyzed.length, total: projects.length })}</span>
        <span className="flex-1" />
        <button type="button" onClick={() => open(batchesFor((r) => presetSelection(r.rows, "minorPatch")))} className={buttonClass({ variant: "ghost", size: "sm" })}>
          {t("deps.presetMinorPatchAll")}
        </button>
        <button type="button" onClick={() => open(batchesFor((r) => presetSelection(r.rows, "vulnerable")))} className={buttonClass({ variant: "ghost", size: "sm" })}>
          {t("deps.presetVulnerableAll")}
        </button>
        <button type="button" disabled={picked.size === 0} onClick={() => open(pickedBatches())} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <GitPullRequest size={12} />
          {t("deps.updatePicked", { n: picked.size })}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-[var(--cf-border)] text-left text-[11px] text-[var(--cf-text-muted)]">
              <th className="w-8 px-3 py-1.5" />
              <th className="min-w-[200px] px-1 py-1.5 font-medium">{t("deps.colPackage")}</th>
              <th className="px-2 py-1.5 font-medium">{t("deps.colLatest")}</th>
              {analyzed.map((p) => (
                <th key={p.id} className="max-w-[140px] truncate px-2 py-1.5 font-medium">
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key} className="border-b border-[var(--cf-border)] hover:bg-[var(--cf-hover)]">
                <td className="px-3 py-1">
                  <Checkbox
                    checked={picked.has(r.key)}
                    onChange={(c) =>
                      setPicked((s) => {
                        const next = new Set(s);
                        if (c) next.add(r.key);
                        else next.delete(r.key);
                        return next;
                      })
                    }
                  />
                </td>
                <td className="px-1 py-1">
                  <span className="flex items-center gap-1.5">
                    <span className="font-medium text-[var(--cf-text)]">{r.name}</span>
                    <span className={chipClass("neutral")}>{ECOSYSTEM_LABEL[r.ecosystem]}</span>
                  </span>
                </td>
                <td className="px-2 py-1 font-mono text-[11.5px] text-[var(--cf-text-muted)]">{r.latest ?? r.newestUsed ?? "—"}</td>
                {analyzed.map((p) => {
                  const cell = r.cells[p.id];
                  if (!cell) return <td key={p.id} className="px-2 py-1 text-[var(--cf-text-faint)]" />;
                  const color = cell.severity && severityTone(cell.severity) === "bad" ? "var(--cf-danger)" : cell.behind ? "var(--cf-warning)" : "var(--cf-text)";
                  return (
                    <td key={p.id} className="px-2 py-1">
                      <Tooltip
                        label={cell.versions.join(", ") || "—"}
                        description={[cell.behind ? t("deps.cellBehind") : null, cell.severity ? t(SEVERITY_LABEL[cell.severity]) : null].filter(Boolean).join(" · ") || undefined}
                      >
                        <span className="font-mono text-[11.5px]" style={{ color }}>
                          {cell.versions.join(", ") || "?"}
                          {cell.severity ? " !" : ""}
                        </span>
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
