import { describe, expect, it } from "vitest";
import type { DepsAdvisory, DepsReport, DepsRow } from "../../lib/tauri/depsCommands";
import {
  EMPTY_FILTERS,
  compareVersions,
  filterRows,
  pivot,
  presetSelection,
  rowId,
  summarize,
  toUpdateItem,
  transitiveAsText,
  vulnerableTarget,
  worstSeverity,
} from "./depsLogic";

function advisory(over: Partial<DepsAdvisory> = {}): DepsAdvisory {
  return { id: "GHSA-1", aliases: [], summary: "", severity: "high", score: 7.5, url: "", fixed: "1.2.5", published: null, ...over };
}

function row(over: Partial<DepsRow> = {}): DepsRow {
  return {
    ecosystem: "npm",
    name: "left-pad",
    key: "left-pad",
    manifest: "package.json",
    section: "dependencies",
    requirement: "^1.2.0",
    current: "1.2.0",
    locked: true,
    latest: null,
    compatible: null,
    tooRecent: null,
    update: "none",
    compatibleUpdate: "none",
    bumpLatest: null,
    bumpCompatible: null,
    license: "MIT",
    licenseStatus: "ok",
    advisories: [],
    url: null,
    error: null,
    stale: false,
    ...over,
  };
}

function report(projectId: string, rows: DepsRow[]): DepsReport {
  return { projectId, analyzedAt: 0, manifests: [], lockfiles: [], rows, transitive: [], lockedCount: 0, warnings: [], osvError: null, minReleaseAgeDays: 7 };
}

const outdatedMinor = row({ name: "a", key: "a", latest: "2.0.0", update: "major", compatible: "1.4.0", compatibleUpdate: "minor", bumpLatest: "^2.0.0", bumpCompatible: "^1.4.0" });
const vulnerable = row({
  name: "b",
  key: "b",
  advisories: [advisory({ fixed: "1.2.5" })],
  latest: "3.0.0",
  update: "major",
  compatible: "1.3.0",
  compatibleUpdate: "minor",
  bumpLatest: "^3.0.0",
  bumpCompatible: "^1.3.0",
});
const flagged = row({ name: "c", key: "c", licenseStatus: "flag", license: "GPL-3.0", ecosystem: "cargo" });

describe("depsLogic", () => {
  it("orders versions like the backend for the cases a fix needs", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });

  it("counts the summary chips, transitive vulnerabilities included", () => {
    const r = report("p", [outdatedMinor, vulnerable, flagged]);
    r.transitive = [{ ecosystem: "npm", name: "minimist", version: "1.2.5", lockfile: "package-lock.json", advisories: [advisory({ severity: "critical" })] }];
    const s = summarize(r);
    expect(s.outdated).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(s.vulnerable.high).toBe(1);
    expect(s.vulnerable.critical).toBe(1);
    expect(s.vulnerableTotal).toBe(1);
    expect(s.transitiveVulnerable).toBe(1);
    expect(s.licenseFlag).toBe(1);
  });

  it("filters by ecosystem, update kind, vulnerability, licence and text", () => {
    const rows = [outdatedMinor, vulnerable, flagged];
    expect(filterRows(rows, { ...EMPTY_FILTERS, ecosystem: "cargo" })).toEqual([flagged]);
    expect(filterRows(rows, { ...EMPTY_FILTERS, update: "outdated" })).toHaveLength(2);
    expect(filterRows(rows, { ...EMPTY_FILTERS, vulnerableOnly: true })).toEqual([vulnerable]);
    expect(filterRows(rows, { ...EMPTY_FILTERS, licenseOnly: true })).toEqual([flagged]);
    expect(filterRows(rows, { ...EMPTY_FILTERS, search: "B" })).toEqual([vulnerable]);
  });

  it("moves a vulnerable package the smallest way that reaches every fix", () => {
    expect(vulnerableTarget(vulnerable)).toBe("compatible");
    const farFix = { ...vulnerable, advisories: [advisory({ fixed: "2.5.0" })] };
    expect(vulnerableTarget(farFix)).toBe("latest");
    expect(worstSeverity([advisory({ severity: "low" }), advisory({ severity: "critical" })])).toBe("critical");
  });

  it("selects rows per batch preset", () => {
    const rows = [outdatedMinor, vulnerable, flagged];
    expect([...presetSelection(rows, "minorPatch").entries()]).toEqual([
      [rowId(outdatedMinor), "compatible"],
      [rowId(vulnerable), "compatible"],
    ]);
    expect([...presetSelection(rows, "vulnerable").keys()]).toEqual([rowId(vulnerable)]);
    expect(presetSelection(rows, "all").get(rowId(outdatedMinor))).toBe("latest");
  });

  it("turns a row into an update item naming the advisories it fixes", () => {
    const item = toUpdateItem(vulnerable, "compatible");
    expect(item?.bump).toMatchObject({ from: "^1.2.0", to: "^1.3.0", name: "b" });
    expect(item?.fixes).toEqual(["GHSA-1"]);
    expect(item?.resolved).toBe("1.2.0");
    expect(toUpdateItem(flagged, "latest")).toBeNull();
  });

  it("pivots a dependency across repositories and marks who is behind", () => {
    const reports = [
      report("p1", [row({ name: "react", key: "react", current: "18.2.0", latest: "18.3.1" })]),
      report("p2", [row({ name: "react", key: "react", current: "18.3.1", advisories: [advisory({ severity: "medium" })] })]),
      report("p3", [row({ name: "Django", key: "Django", ecosystem: "pypi", current: "4.2" })]),
      report("p4", [row({ name: "django", key: "django", ecosystem: "pypi", current: "5.0" })]),
    ];
    const rows = pivot(reports);
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.name === "react")!;
    const second = rows.find((r) => r.ecosystem === "pypi")!;
    expect(first.newestUsed).toBe("18.3.1");
    expect(first.cells.p1.behind).toBe(true);
    expect(first.cells.p2.behind).toBe(false);
    expect(first.cells.p2.severity).toBe("medium");
    expect(second.repos).toBe(2);
    expect(second.cells.p3.behind).toBe(true);
  });
});

describe("transitiveAsText", () => {
  it("writes one heading per package and one line per advisory, CVE alias first", () => {
    const text = transitiveAsText([
      {
        ecosystem: "npm",
        name: "left-pad",
        version: "1.2.0",
        lockfile: "pnpm-lock.yaml",
        advisories: [
          advisory({ id: "GHSA-1", aliases: ["CVE-2026-1"], summary: "Bad thing", url: "https://example.com/a" }),
          advisory({ id: "GHSA-2", severity: "unknown", score: null, fixed: null, summary: "Other", url: "https://example.com/b" }),
        ],
      },
    ]);
    expect(text).toBe(
      [
        "left-pad 1.2.0 (pnpm-lock.yaml)",
        "  - [high 7.5] CVE-2026-1: Bad thing (fixed in 1.2.5) https://example.com/a",
        "  - [unknown] GHSA-2: Other https://example.com/b",
      ].join("\n"),
    );
  });
});
