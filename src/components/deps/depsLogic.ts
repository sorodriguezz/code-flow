/**
 * The «Dependencias» section's judgement, without a DOM: the summary chips, the filters, the
 * workspace pivot and which rows a batch preset selects. Everything the backend decided (versions,
 * classification, licence status) arrives already decided; this only counts, filters and groups.
 */

import type {
  DepsAdvisory,
  DepsEcosystem,
  DepsReport,
  DepsRow,
  DepsSeverity,
  DepsUpdateItem,
  DepsUpdateKind,
} from "../../lib/tauri/depsCommands";

export const SEVERITY_ORDER: DepsSeverity[] = ["critical", "high", "medium", "low", "unknown"];

const SEVERITY_RANK: Record<DepsSeverity, number> = { unknown: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function worstSeverity(advisories: DepsAdvisory[]): DepsSeverity | null {
  if (advisories.length === 0) return null;
  return advisories.reduce<DepsSeverity>((worst, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[worst] ? a.severity : worst), "unknown");
}

/** One row's identity inside a report: the same package can sit in two manifests or two sections. */
export function rowId(row: Pick<DepsRow, "manifest" | "section" | "key">): string {
  return `${row.manifest}|${row.section}|${row.key}`;
}

/** The package across repositories: PyPI and NuGet names fold case (the backend's `normalize`). */
export function packageKey(ecosystem: DepsEcosystem, name: string): string {
  const folded = ecosystem === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : ecosystem === "nuget" ? name.toLowerCase() : name;
  return `${ecosystem}:${folded}`;
}

export interface DepsSummary {
  outdated: Record<Exclude<DepsUpdateKind, "none">, number>;
  vulnerable: Record<DepsSeverity, number>;
  vulnerableTotal: number;
  transitiveVulnerable: number;
  licenseFlag: number;
  licenseWarn: number;
}

export function summarize(report: DepsReport | null | undefined): DepsSummary {
  const out: DepsSummary = {
    outdated: { major: 0, minor: 0, patch: 0 },
    vulnerable: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    vulnerableTotal: 0,
    transitiveVulnerable: 0,
    licenseFlag: 0,
    licenseWarn: 0,
  };
  if (!report) return out;
  for (const row of report.rows) {
    if (row.update !== "none") out.outdated[row.update] += 1;
    const worst = worstSeverity(row.advisories);
    if (worst) {
      out.vulnerable[worst] += 1;
      out.vulnerableTotal += 1;
    }
    if (row.licenseStatus === "flag") out.licenseFlag += 1;
    if (row.licenseStatus === "warn") out.licenseWarn += 1;
  }
  for (const t of report.transitive) {
    const worst = worstSeverity(t.advisories);
    if (worst) {
      out.vulnerable[worst] += 1;
      out.transitiveVulnerable += 1;
    }
  }
  return out;
}

export type UpdateFilter = "all" | "outdated" | "major" | "minor" | "patch";

export interface RowFilters {
  ecosystem: DepsEcosystem | "all";
  update: UpdateFilter;
  vulnerableOnly: boolean;
  licenseOnly: boolean;
  search: string;
}

export const EMPTY_FILTERS: RowFilters = { ecosystem: "all", update: "all", vulnerableOnly: false, licenseOnly: false, search: "" };

export function filterRows(rows: DepsRow[], f: RowFilters): DepsRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (f.ecosystem !== "all" && row.ecosystem !== f.ecosystem) return false;
    if (f.update === "outdated" && row.update === "none") return false;
    if ((f.update === "major" || f.update === "minor" || f.update === "patch") && row.update !== f.update) return false;
    if (f.vulnerableOnly && row.advisories.length === 0) return false;
    if (f.licenseOnly && row.licenseStatus !== "flag" && row.licenseStatus !== "warn") return false;
    if (q && !row.name.toLowerCase().includes(q) && !row.manifest.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Numbers first, then a qualifier that sorts below the bare release — enough to compare a fix. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const s = v.trim().replace(/^[v=]+/i, "").split("+")[0];
    const m = /^([0-9]+(?:\.[0-9]+)*)(.*)$/.exec(s);
    return { nums: (m?.[1] ?? "0").split(".").map(Number), pre: (m?.[2] ?? "").replace(/^[-._]/, "") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export type UpdateTarget = "latest" | "compatible";

/**
 * The target a vulnerable row should move to: the in-line update when it reaches every fix (the
 * smallest jump that closes the advisories), the newest otherwise.
 */
export function vulnerableTarget(row: DepsRow): UpdateTarget | null {
  const fixes = row.advisories.map((a) => a.fixed).filter((f): f is string => !!f);
  const reaches = (v: string | null) => !!v && fixes.every((f) => compareVersions(v, f) >= 0);
  if (row.bumpCompatible && row.compatibleUpdate !== "none" && reaches(row.compatible)) return "compatible";
  if (row.bumpLatest && row.update !== "none") return "latest";
  return null;
}

export type SelectionPreset = "minorPatch" | "vulnerable" | "all";

/** Rows a preset selects, and to which target. Rows with nothing we can rewrite are left out. */
export function presetSelection(rows: DepsRow[], preset: SelectionPreset): Map<string, UpdateTarget> {
  const out = new Map<string, UpdateTarget>();
  for (const row of rows) {
    let target: UpdateTarget | null = null;
    if (preset === "minorPatch") {
      if (row.bumpCompatible && (row.compatibleUpdate === "minor" || row.compatibleUpdate === "patch")) target = "compatible";
    } else if (preset === "vulnerable") {
      if (row.advisories.length > 0) target = vulnerableTarget(row);
    } else if (row.bumpLatest && row.update !== "none") {
      target = "latest";
    }
    if (target) out.set(rowId(row), target);
  }
  return out;
}

export function toUpdateItem(row: DepsRow, target: UpdateTarget): DepsUpdateItem | null {
  const to = target === "latest" ? row.bumpLatest : row.bumpCompatible;
  const toVersion = target === "latest" ? row.latest : row.compatible;
  if (!to || !toVersion || to === row.requirement) return null;
  const fixes = row.advisories.filter((a) => !a.fixed || compareVersions(toVersion, a.fixed) >= 0).map((a) => a.id);
  return {
    manifest: row.manifest,
    bump: { ecosystem: row.ecosystem, name: row.name, key: row.key, section: row.section, from: row.requirement, to, property: row.property ?? null },
    resolved: row.locked ? row.current : null,
    toVersion,
    fixes,
  };
}

// --- The workspace pivot --------------------------------------------------------------------------

export interface PivotCell {
  /** Every version the repository uses (two manifests can disagree). */
  versions: string[];
  /** Below the newest version any repository uses, or below the newest suggested release. */
  behind: boolean;
  severity: DepsSeverity | null;
}

export interface PivotRow {
  key: string;
  ecosystem: DepsEcosystem;
  name: string;
  /** The newest version in use anywhere. */
  newestUsed: string | null;
  /** The newest suggested release the registry reported. */
  latest: string | null;
  cells: Record<string, PivotCell>;
  repos: number;
  behindCount: number;
}

export function pivot(reports: DepsReport[]): PivotRow[] {
  const rows = new Map<string, PivotRow>();
  for (const report of reports) {
    for (const dep of report.rows) {
      const key = packageKey(dep.ecosystem, dep.name);
      let row = rows.get(key);
      if (!row) {
        row = { key, ecosystem: dep.ecosystem, name: dep.name, newestUsed: null, latest: null, cells: {}, repos: 0, behindCount: 0 };
        rows.set(key, row);
      }
      const cell = (row.cells[report.projectId] ??= { versions: [], behind: false, severity: null });
      if (dep.current && !cell.versions.includes(dep.current)) cell.versions.push(dep.current);
      const worst = worstSeverity(dep.advisories);
      if (worst && (!cell.severity || SEVERITY_RANK[worst] > SEVERITY_RANK[cell.severity])) cell.severity = worst;
      if (dep.current && (!row.newestUsed || compareVersions(dep.current, row.newestUsed) > 0)) row.newestUsed = dep.current;
      if (dep.latest && (!row.latest || compareVersions(dep.latest, row.latest) > 0)) row.latest = dep.latest;
    }
  }
  for (const row of rows.values()) {
    const bar = [row.newestUsed, row.latest].filter((v): v is string => !!v).sort(compareVersions).pop() ?? null;
    for (const cell of Object.values(row.cells)) {
      cell.versions.sort(compareVersions);
      const oldest = cell.versions[0];
      cell.behind = !!bar && !!oldest && compareVersions(oldest, bar) < 0;
    }
    row.repos = Object.keys(row.cells).length;
    row.behindCount = Object.values(row.cells).filter((c) => c.behind).length;
  }
  // Shared dependencies first — those are the ones a workspace view exists for.
  return [...rows.values()].sort((a, b) => b.repos - a.repos || b.behindCount - a.behindCount || a.name.localeCompare(b.name));
}
